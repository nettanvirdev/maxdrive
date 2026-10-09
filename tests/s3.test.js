import { describe, expect, it } from "vitest";
import { sign, encode, EMPTY_SHA256 } from "../src/main/s3/sigv4.cjs";
import { tag, blocks } from "../src/main/s3/xml.cjs";
import { objectsToRows, normalizePrefix, parentKey, md5FromEtag } from "../src/main/s3/keys.cjs";

// AWS's published S3 SigV4 examples (docs: "Signature Calculations for the
// Authorization Header"), using their documented example credentials.
const AWS = {
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  date: new Date("2013-05-24T00:00:00Z"),
};

describe("sigv4", () => {
  it("matches the AWS GET Object example", () => {
    const h = sign({ ...AWS, method: "GET", path: "/test.txt", headers: { Range: "bytes=0-9" }, payloadHash: EMPTY_SHA256 });
    expect(h.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(h.host).toBeUndefined(); // fetch sets Host itself
  });

  it("matches the AWS List Objects example (sorted query)", () => {
    const h = sign({ ...AWS, method: "GET", path: "/", query: { prefix: "J", "max-keys": 2 }, payloadHash: EMPTY_SHA256 });
    expect(h.Authorization).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });

  it("encodes keys the strict SigV4 way", () => {
    expect(encode("a b/c(1)!.txt", true)).toBe("a%20b/c%281%29%21.txt");
    expect(encode("a/b")).toBe("a%2Fb");
  });
});

describe("xml", () => {
  it("reads tags and repeated blocks, decoding entities", () => {
    const xml =
      "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;1</NextContinuationToken>" +
      "<Contents><Key>a.txt</Key><Size>3</Size></Contents><Contents><Key>b &lt;1&gt;.txt</Key><Size>4</Size></Contents></ListBucketResult>";
    expect(tag(xml, "NextContinuationToken")).toBe("t&1");
    expect(blocks(xml, "Contents").map((c) => tag(c, "Key"))).toEqual(["a.txt", "b <1>.txt"]);
    expect(tag(xml, "Missing")).toBeNull();
  });
});

describe("keys → tree", () => {
  const nodeId = (acct, key) => `g:${acct}:${key}`;

  it("normalizes prefixes", () => {
    expect(normalizePrefix("")).toBe("");
    expect(normalizePrefix("/team/docs/")).toBe("team/docs/");
    expect(normalizePrefix("team")).toBe("team/");
  });

  it("finds parents relative to the account prefix", () => {
    expect(parentKey("", "a.txt")).toBeNull();
    expect(parentKey("", "photos/2024/x.jpg")).toBe("photos/2024/");
    expect(parentKey("p/", "p/x.jpg")).toBeNull();
    expect(parentKey("", "photos/2024/")).toBe("photos/");
  });

  it("synthesizes folders once, hides plumbing, and keeps only real MD5s", () => {
    const seen = new Set();
    const rows = objectsToRows(
      "s3_x",
      "p/",
      [
        { key: "p/photos/2024/a.jpg", size: 10, etag: "d41d8cd98f00b204e9800998ecf8427e", lastModified: 1 },
        { key: "p/photos/2024/b.jpg", size: 20, etag: "abc-3", lastModified: 2 },
        { key: "p/empty/", size: 0, etag: "", lastModified: 3 },
        { key: "p/MaxDrive/.maxdrive-probe", size: 1, etag: "", lastModified: 4 },
        { key: "other/outside.txt", size: 1, etag: "", lastModified: 5 },
      ],
      { seen, now: 99, nodeId },
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.drive_file_id, r]));
    expect(Object.keys(byKey).sort()).toEqual(
      ["p/empty/", "p/photos/", "p/photos/2024/", "p/photos/2024/a.jpg", "p/photos/2024/b.jpg"].sort(),
    );
    expect(byKey["p/photos/"]).toMatchObject({ is_folder: 1, drive_parent_id: null, name: "photos" });
    expect(byKey["p/photos/2024/a.jpg"]).toMatchObject({
      id: "g:s3_x:p/photos/2024/a.jpg",
      drive_parent_id: "p/photos/2024/",
      md5: "d41d8cd98f00b204e9800998ecf8427e",
      mime: "image/jpeg",
    });
    expect(byKey["p/photos/2024/b.jpg"].md5).toBeNull();

    // A second page must not repeat folders already written.
    const again = objectsToRows("s3_x", "p/", [{ key: "p/photos/2024/c.jpg", size: 1, etag: "", lastModified: 1 }], { seen, now: 99, nodeId });
    expect(again.map((r) => r.drive_file_id)).toEqual(["p/photos/2024/c.jpg"]);
  });

  it("only trusts single-part ETags as MD5", () => {
    expect(md5FromEtag("D41D8CD98F00B204E9800998ECF8427E")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5FromEtag("abc-2")).toBeNull();
  });
});
