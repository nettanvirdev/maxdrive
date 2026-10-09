import { describe, it, expect } from "vitest";
import { accountName, s3Location } from "@/lib/accounts";
import { COMMAND_MAP, isAvailable } from "@/commands/registry";

const s3 = {
  provider: "s3",
  email: "photos@minio.lan/archive",
  display_name: null,
  config: { endpoint: "https://minio.lan:9000", bucket: "photos", prefix: "archive/" },
};

describe("S3 account helpers", () => {
  it("names an S3 account by label, then bucket", () => {
    expect(accountName(s3)).toBe("photos");
    expect(accountName({ ...s3, display_name: "NAS" })).toBe("NAS");
    expect(accountName({ email: "a@gmail.com" })).toBe("a@gmail.com");
  });

  it("describes where the bucket lives", () => {
    expect(s3Location(s3)).toBe("photos/archive · minio.lan:9000");
    expect(s3Location({ config: { endpoint: "", bucket: "b", prefix: "" } })).toBe(
      "b · AWS S3",
    );
  });
});

describe("Drive-only commands", () => {
  const node = {
    id: "g:acc:f",
    drive_file_id: "f",
    account_id: "acc",
    web_view_link: "https://example.test",
  };
  const ctx = (provider) => ({ node: { ...node, account_provider: provider } });

  it.each(["file.share", "file.createLink", "file.openExternal"])(
    "%s is offered on Drive files only",
    (id) => {
      expect(isAvailable(COMMAND_MAP.get(id), ctx("gdrive"))).toBe(true);
      expect(isAvailable(COMMAND_MAP.get(id), ctx("s3"))).toBe(false);
    },
  );
});
