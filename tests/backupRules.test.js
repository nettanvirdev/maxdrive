import { describe, expect, it } from "vitest";
import { compileRules, extOf, normaliseExt } from "../src/main/localBackup/rules.cjs";

describe("normaliseExt", () => {
  it("strips dots and lowercases", () => {
    expect(normaliseExt(".ENV")).toBe("env");
    expect(normaliseExt("env")).toBe("env");
    expect(normaliseExt("..Env ")).toBe("env");
  });
});

describe("extOf", () => {
  it("treats a dotfile's whole name as its extension", () => {
    expect(extOf(".env")).toBe("env");
    expect(extOf("project/.env")).toBe("env");
  });
  it("takes the last extension segment", () => {
    expect(extOf("a/b/archive.tar.gz")).toBe("gz");
    expect(extOf("Report.DOCX")).toBe("docx");
  });
  it("returns empty for extensionless names", () => {
    expect(extOf("Makefile")).toBe("");
    expect(extOf("dir/LICENSE")).toBe("");
  });
});

describe("compileRules", () => {
  it("applies the defaults when no rules are given", () => {
    const rules = compileRules(null);
    expect(rules.skipDir("node_modules")).toBe(true);
    expect(rules.skipDir(".git")).toBe(true);
    expect(rules.skipDir("src")).toBe(false);
    expect(rules.includeFile("project/.env")).toBe(false);
    expect(rules.includeFile("project/app.js")).toBe(true);
  });

  it("matches ignored directories case-insensitively at any depth", () => {
    const rules = compileRules({ ignoreDirs: ["Node_Modules"] });
    expect(rules.skipDir("node_modules")).toBe(true);
    expect(rules.skipDir("NODE_MODULES")).toBe(true);
  });

  it("accepts rules as a JSON string (the DB column form)", () => {
    const rules = compileRules('{"excludeExts": [".log"]}');
    expect(rules.includeFile("a/app.log")).toBe(false);
    expect(rules.includeFile("a/app.txt")).toBe(true);
  });

  it("include-only list wins over the exclude list", () => {
    const rules = compileRules({ includeExts: [".docx", "pdf"], excludeExts: [".docx"] });
    expect(rules.includeFile("x/notes.docx")).toBe(true);
    expect(rules.includeFile("x/scan.PDF")).toBe(true);
    expect(rules.includeFile("x/app.js")).toBe(false);
    expect(rules.includeFile("x/.env")).toBe(false);
  });

  it("an empty include list means include everything not excluded", () => {
    const rules = compileRules({ includeExts: [], excludeExts: [".env"] });
    expect(rules.includeFile("x/app.js")).toBe(true);
    expect(rules.includeFile("x/.env")).toBe(false);
  });

  it("excluding .env catches both dotfiles and named .env files", () => {
    const rules = compileRules({ excludeExts: [".env"] });
    expect(rules.includeFile(".env")).toBe(false);
    expect(rules.includeFile("api/.env")).toBe(false);
    expect(rules.includeFile("api/production.env")).toBe(false);
  });

  it("survives malformed JSON by falling back to defaults", () => {
    const rules = compileRules("{not json");
    expect(rules.skipDir("node_modules")).toBe(true);
  });
});
