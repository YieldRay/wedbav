import { encodePath, removeSuffixSlash } from "./utils.ts";

export function escapeXML(str: string) {
  const map: Record<string, string> = {
    ">": "&gt;",
    "<": "&lt;",
    "'": "&apos;",
    '"': "&quot;",
    "&": "&amp;",
  };
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    result += map[ch] || ch;
  }
  return result;
}

export function davXML(
  date: Date,
  dir: string,
  filesOrThisIsFile: Array<{ path: string; contentlength: number; lastmodified: Date; isdir: boolean }> | true = [],
) {
  const files = filesOrThisIsFile === true ? [] : filesOrThisIsFile;
  const isDir = filesOrThisIsFile !== true;

  return /* xml */ `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<d:multistatus xmlns:d="DAV:">
${davXMLSingleResponse(dir, 0, date, isDir)}
${files
  .map(({ path, contentlength, lastmodified, isdir }) => davXMLSingleResponse(path, contentlength, lastmodified, isdir))
  .join("\n")}    
</d:multistatus>`;
}

function davXMLSingleResponse(path: string, contentlength: number, lastmodified: Date, isdir: boolean) {
  const getNameFromRawPath = (path: string) => removeSuffixSlash(path).split("/").pop() || "/";

  return /* xml */ `<d:response>
    <d:href>${encodePath(path) + (isdir ? "/" : "")}</d:href>
    <d:propstat>
        <d:prop>
            <d:displayname>${getNameFromRawPath(path)}</d:displayname>
            <d:getcontentlength>${contentlength}</d:getcontentlength>
            <d:getlastmodified>${lastmodified.toUTCString()}</d:getlastmodified>
            <d:resourcetype>${isdir ? "<d:collection/>" : ""}</d:resourcetype>${
              isdir
                ? "<d:getcontenttype>httpd/unix-directory</d:getcontenttype>"
                : "<d:getcontenttype>application/octet-stream</d:getcontenttype>"
            }
        </d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
</d:response>`;
}
