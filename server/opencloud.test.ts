import { describe, expect, it } from "vitest";
import { davPath, parseMultistatus } from "./opencloud.ts";

// A PROPFIND answer in the form reva's ocdav writes it: d: and oc: prefixes, a 200 propstat and a 404 one for the
// properties a folder does not have.
const REVA = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:s="http://sabredav.org/ns" xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
<d:response><d:href>/remote.php/dav/spaces/1284d238-aa92$4c510ada-c86b/Audit%202026/</d:href>
<d:propstat><d:prop><oc:fileid>1284d238-aa92$4c510ada-c86b!b2c3</oc:fileid><oc:size>4096</oc:size><d:resourcetype><d:collection/></d:resourcetype>
<d:getlastmodified>Wed, 04 Nov 2026 09:40:00 GMT</d:getlastmodified><oc:share-types><oc:share-type>3</oc:share-type></oc:share-types></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
<d:propstat><d:prop><d:getcontentlength></d:getcontentlength><d:getcontenttype></d:getcontenttype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/spaces/1284d238-aa92$4c510ada-c86b/Audit%202026/Q3%20%26%20Q4.pdf</d:href>
<d:propstat><d:prop><d:getcontentlength>2400</d:getcontentlength><d:getcontenttype>application/pdf</d:getcontenttype><d:resourcetype/>
<d:getetag>&quot;8f1e&quot;</d:getetag><oc:has-preview>0</oc:has-preview><oc:share-types/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

describe("WebDAV answers", () => {
  it("are read by local name, with only what OpenCloud found", () => {
    const [folder, file] = parseMultistatus(REVA);
    expect(folder!.href).toBe("/remote.php/dav/spaces/1284d238-aa92$4c510ada-c86b/Audit%202026/");
    expect(folder!.props).toMatchObject({ fileid: "1284d238-aa92$4c510ada-c86b!b2c3", size: "4096", resourcetype: "<d:collection/>" });
    expect(folder!.props).not.toHaveProperty("getcontentlength");
    expect(folder!.props["share-types"]).toContain("<oc:share-type>3</oc:share-type>");
    expect(file!.href).toBe("/remote.php/dav/spaces/1284d238-aa92$4c510ada-c86b/Audit%202026/Q3%20%26%20Q4.pdf");
    expect(file!.props).toMatchObject({ getcontentlength: "2400", resourcetype: "", getetag: "&quot;8f1e&quot;", "share-types": "" });
  });

  it("paths stay inside the space", () => {
    expect(davPath("/Audit 2026//Q3 & Q4.pdf")).toBe("Audit%202026/Q3%20%26%20Q4.pdf");
    expect(davPath("")).toBe("");
    expect(() => davPath("Audit 2026/../../other")).toThrow("Not a path in this space.");
  });
});
