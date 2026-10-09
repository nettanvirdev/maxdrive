import { expect, it } from "vitest";
import { uploadName } from "../src/main/drive/uploadName.cjs";

it("names the Drive file from transfer.name, not the temp path", () => {
  expect(uploadName({ name: "photo.jpg", local_path: "/tmp/3f2a-uuid-photo.jpg" })).toBe("photo.jpg");
  expect(uploadName({ name: null, local_path: "/home/me/report.pdf" })).toBe("report.pdf");
});
