import { APIGatewayProxyHandler } from "aws-lambda";
import { dynamo, headers } from "../lambda-helpers";
import axios from "axios";
import { PullBlock, TreeNode, ViewType } from "roamjs-components/types/native";
import https from "https";

const normalize = (data: unknown): unknown => {
  if (Array.isArray(data)) {
    return data.map(normalize);
  } else if (data === null) {
    return null;
  } else if (typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [
        k.startsWith(":") ? k : `:${k}`,
        normalize(v),
      ])
    );
  } else {
    return data;
  }
};

const q = (query: string) => {
  const graph = "roamjs";
  const args = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ROAM_API_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    // withCredentials: true,
  };

  // return axios
  //   .post(`https://api.roamresearch.com/api/graph/${graph}/q`, { query }, args)
  //   .then((r) => {
  //     if (r.status === 307) {
  //       const loc = (r.headers.location || r.headers.Location) as string;
  //       return axios.post(loc, { query }, args).then((res) => {
  //         const { result } = res.data;
  //         return normalize(result) as [PullBlock][];
  //       });
  //     } else {
  //       return Promise.reject(
  //         new Error(`Expected an immediate redirect (307), got: ${r.status}`)
  //       );
  //     }
  //   });
  return new Promise<PullBlock[][]>((resolve, reject) => {
    const req = https
      .request(
        `https://api.roamresearch.com/api/graph/${graph}/q`,
        args,
        (res) => {
          if (res.statusCode === 307) {
            const redirect = https.request(
              res.headers.location,
              args,
              (redirectRes) => {
                redirectRes.setEncoding("utf8");
                let body = "";
                redirectRes.on("data", (data) => {
                  body += data;
                });
                redirectRes.on("end", () => {
                  if (!redirectRes.statusCode) reject("Missing Status Code");
                  else if (
                    redirectRes.statusCode >= 200 &&
                    redirectRes.statusCode < 400
                  ) {
                    resolve(
                      normalize(JSON.parse(body).result) as [PullBlock][]
                    );
                  } else {
                    reject(new Error(redirectRes.statusMessage));
                  }
                });
                res.on("error", reject);
              }
            );
            redirect.write(JSON.stringify({ query }));
            redirect.end();
          } else {
            reject(
              new Error(
                `Expected an immediate redirect (307), got: ${res.statusCode}`
              )
            );
          }
        }
      )
      .on("error", reject);
    req.write(JSON.stringify({ query }));
    req.end();
  });
};

const getPageTitleByBlockUid = (blockUid: string) =>
  q(
    `[:find (pull ?p [:node/title]) :where [?e :block/uid "${blockUid}"] [?e :block/page ?p]]`
  ).then((r) => r[0]?.[0]?.[":node/title"] || "");

const getTextByBlockUid = (blockUid: string) =>
  q(
    `[:find (pull ?e [:block/string]) :where [?e :block/uid "${blockUid}"]]`
  ).then((r) => r[0]?.[0]?.[":block/string"] || "");

const BLOCK_REF_REGEX = /\(\(([\w\d-]{9,10})\)\)/;
const EMBED_REF_REGEX = new RegExp(
  `{{(?:\\[\\[)?embed(?:\\]\\])?:\\s*${BLOCK_REF_REGEX.source}\\s*}}`,
  "g"
);
const ALIAS_BLOCK_REGEX = new RegExp(
  `\\[(.*?)\\]\\(${BLOCK_REF_REGEX.source}\\)`,
  "g"
);

const viewTypeToPrefix = {
  bullet: "- ",
  document: "",
  numbered: "1. ",
};

const TableName = "RoamJSExtensions";

export const handler: APIGatewayProxyHandler = (event) => {
  const id = event.queryStringParameters?.id;
  const sub = event.queryStringParameters?.sub === "true";
  return id
    ? dynamo
        .getItem({
          TableName,
          Key: { id: { S: id.split("/")[0] } },
        })
        .promise()
        .then((r) => {
          const resolveText = async (
            text: string,
            children: TreeNode[]
          ): Promise<string> => {
            const isExternal = (s: string) =>
              s !== id && !s.startsWith(`${id}/`);
            const replacements = await Promise.all(
              Array.from(text.matchAll(EMBED_REF_REGEX))
                .map((arr) =>
                  getContentBlocks(arr[1], true).then(async (node) => {
                    children.push(...node.blocks);
                    return {
                      value: await resolveText(node.text, children),
                      from: arr.index,
                      to: arr.index + arr[0].length,
                    };
                  })
                )
                .concat(
                  Array.from(text.matchAll(ALIAS_BLOCK_REGEX)).map((arr) =>
                    getPageTitleByBlockUid(arr[2]).then((page) => {
                      return {
                        value: isExternal(page)
                          ? arr[1]
                          : `[${arr[1]}](/extensions/${page}#${arr[2]})`,
                        from: arr.index,
                        to: arr.index + arr[0].length,
                      };
                    })
                  )
                )
                .concat(
                  Array.from(
                    text.matchAll(
                      new RegExp(`${BLOCK_REF_REGEX.source}(?![})])`, "g")
                    )
                  ).map((arr) =>
                    getTextByBlockUid(arr[1]).then((reference) =>
                      getPageTitleByBlockUid(arr[1]).then((title) => {
                        const page = title.replace(/ /g, "_").toLowerCase();
                        return {
                          value: isExternal(page)
                            ? reference || arr[0]
                            : `[${reference}](/extensions/${page}#${arr[1]})`,
                          from: arr.index,
                          to: arr.index + arr[0].length,
                        };
                      })
                    )
                  )
                )
            );
            return replacements
              .sort((a, b) => b.from - a.from)
              .reduce((p, c) => {
                return `${p.slice(0, c.from)}${c.value}${p.slice(c.to)}`;
              }, text);
          };
          const formatRoamNode = async (
            n: PullBlock,
            v: ViewType
          ): Promise<TreeNode> => {
            const viewType = n[":children/view-type"]
              ? (n[":children/view-type"].replace(/^:/, "") as ViewType)
              : v;
            const children = await Promise.all(
              (n[":block/children"] || [])
                .sort(
                  (
                    { [":block/order"]: a }: PullBlock,
                    { [":block/order"]: b }: PullBlock
                  ) => a - b
                )
                .map((r) => formatRoamNode(r, viewType))
            );
            const text = n[":block/string"] || n[":node/title"] || "";

            return {
              text: await resolveText(text, children),
              open:
                typeof n[":block/open"] === "undefined"
                  ? true
                  : n[":block/open"],
              order: n[":block/order"] || 0,
              uid: n[":block/uid"] || "",
              heading: n[":block/heading"] || 0,
              viewType,
              editTime: new Date(n[":edit/time"] || 0),
              props: { imageResize: {}, iframe: {} },
              textAlign: n[":block/text-align"] || "left",
              children,
            };
          };

          const getContentBlocks = async (id: string, uid?: true) =>
            q(`[:find (pull ?b [
  :block/string 
  :node/title 
  :block/uid 
  :block/order 
  :block/heading 
  :block/open 
  :children/view-type 
  :block/text-align
  :edit/time 
  :block/props 
  {:block/children ...}
]) :where [?b ${uid ? ":block/uid" : ":node/title"} "${id}"]]`).then(
              async (r) => {
                const viewType =
                  (r[0]?.[0]?.[":children/view-type"]?.replace(
                    /^:/,
                    ""
                  ) as ViewType) || "bullet";
                const path = id.split("/")[0];
                return {
                  blocks: await Promise.all(
                    ((r[0]?.[0]?.[":block/children"] as PullBlock[]) || [])
                      .sort((a, b) => a[":block/order"] - b[":block/order"])
                      .map((c) => formatRoamNode(c, viewType))
                  ),
                  viewType,
                  path,
                  text:
                    r[0]?.[0]?.[":block/string"] || r[0]?.[0]?.[":node/title"],
                };
              }
            );
          return getContentBlocks(id)
            .then(({ blocks, viewType, path }) => {
              const docs =
                id === path
                  ? blocks.find((f) => /^\s*Documentation\s*$/i.test(f.text))
                      ?.children || []
                  : blocks;
              if (
                docs.length === 1 &&
                /^https:\/\/github.com\/[\w]+\/[\w-]+$/.test(docs[0].text)
              )
                return axios
                  .get<string>(
                    `${docs[0].text.replace(
                      /github\.com/,
                      "raw.githubusercontent.com"
                    )}/main/README.md`,
                    { responseType: "text" }
                  )
                  .then((r) =>
                    (r.data || "").replace(/https:\/\/roamjs\.com/g, (s) =>
                      process.env.NODE_ENV === "development"
                        ? "http://localhost:3000"
                        : s
                    )
                  );
              else {
                const replaceComponents = (
                  text: string,
                  prefix: string
                ): string =>
                  text
                    .replace(
                      /{{(?:\[\[)?video(?:\]\])?:(?:\s)*https:\/\/www.loom.com\/share\/([0-9a-f]*)}}/g,
                      (_, id) => `<Loom id={"${id}"} />`
                    )
                    .replace(
                      /{{(?:\[\[)?(?:youtube|video)(?:\]\])?:(?:\s)*https:\/\/(?:youtu\.be\/([\w\d-]*)|(?:www\.)youtube.com\/watch\?v=([\w\d-]+)[^}]+)}}/g,
                      (_, id, otherId) => `<YouTube id={"${id || otherId}"} />`
                    )
                    .replace(
                      /{{(?:\[\[)?video(?:\]\])?:(?:\s)*([^\s]+)(?:\s)*}}/g,
                      (_, id) => `<DemoVideo src={"${id}"} />`
                    )
                    .replace(
                      new RegExp(
                        `\\[(.*?)\\]\\(\\[\\[${path}/(.*?)\\]\\]\\)`,
                        "g"
                      ),
                      (_, label, page) =>
                        `[${label}](/extensions/${path}/${page
                          .replace(/ /g, "_")
                          .toLowerCase()})`
                    )
                    .replace(
                      new RegExp(`\\[(.*?)\\]\\(\\[\\[${path}\\]\\]\\)`, "g"),
                      (_, label) => `[${label}](/extensions/${path})`
                    )
                    .replace(
                      /\^\^(.*?)\^\^/g,
                      (_, i) => `<Highlight>${i}</Highlight>`
                    )
                    .replace(/__/g, "_")
                    .replace(new RegExp(String.fromCharCode(160), "g"), " ")
                    .replace(/```$/, "\n```")
                    .replace(/\n/g, `\n${"".padStart(prefix.length, " ")}`)
                    .replace(/https:\/\/roamjs\.com/g, (s) =>
                      process.env.NODE_ENV === "development"
                        ? "http://localhost:3000"
                        : s
                    );

                const blockToMarkdown = (
                  block: TreeNode,
                  viewType: ViewType,
                  depth = 0
                ): string => {
                  const prefix = `${"".padStart(depth * 4, " ")}${
                    viewTypeToPrefix[viewType || "bullet"]
                  }`;
                  return `${prefix}<Block id={"${block.uid}"}>${"".padStart(
                    block.heading,
                    "#"
                  )}${block.heading > 0 ? " " : ""}${
                    block.textAlign === "center" ? "<Center>" : ""
                  }${
                    /\n/.test(block.text)
                      ? `\n\n${"".padStart(prefix.length)}`
                      : ""
                  }${replaceComponents(block.text, prefix)}${
                    /\n/.test(block.text)
                      ? `\n\n${"".padStart(prefix.length)}`
                      : ""
                  }${
                    block.textAlign === "center" ? "</Center>" : ""
                  }</Block>\n\n${block.children
                    .map((v) =>
                      blockToMarkdown(
                        v,
                        block.viewType,
                        viewType === "document" ? depth : depth + 1
                      )
                    )
                    .join("")}${
                    viewType === "document" && block.children.length ? "\n" : ""
                  }`;
                };
                return docs.map((b) => blockToMarkdown(b, viewType)).join("");
              }
            })
            .then((content) => ({
              statusCode: 200,
              body: JSON.stringify({
                content,
                state: r.Item.state?.S || "PRIVATE",
                description: r.Item.description?.S || "",
                entry: r.Item.src?.S || "",
                downloadUrl: r.Item.download?.S || "",
              }),
              headers: headers(event),
            }));
        })
        .catch((e) => {
          console.error(e);
          return {
            statusCode: e.message === "Too Many Requests" ? 429 : 500,
            body: e.message,
            headers: headers(event),
          };
        })
    : sub
    ? q(`[:find 
           (pull ?b [:node/title]) 
           (pull ?sub [:node/title]) 
          :where 
            [?d :block/string "Documentation"] 
            [?b :block/children ?d] 
            [?b :node/title ?t] 
            [not [[clojure.string/starts-with? ?t "legacy"]]]
            [?sub :node/title ?sub-title]
            [[clojure.string/starts-with? ?sub-title ?t]]
          ]`)
        .then((r) =>
          r
            .filter(([a, b]) =>
              b[":node/title"].startsWith(`${a[":node/title"]}/`)
            )
            .map(([id, sub]) => ({
              subpage: sub?.[":node/title"]?.split("/").slice(1),
              id: id[":node/title"],
            }))
        )
        .then((paths) => ({
          statusCode: 200,
          body: JSON.stringify({ paths }),
          headers: headers(event),
        }))
    : dynamo
        .scan({
          TableName,
        })
        .promise()
        .then(async (r) => ({
          statusCode: 200,
          body: JSON.stringify({
            paths: await Promise.all(
              r.Items.map((c) => ({
                id: c.id?.S,
                description: c.description?.S,
                state: c.state?.S,
                featured: Number(c.featured?.N || 0),
                entry: c.src?.S || "",
              }))
            ),
          }),
          headers: headers(event),
        }));
};
