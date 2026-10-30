import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, parseConfig, watchConfig } from "./config.ts";
import { SPACES } from "./test-app.ts";

describe("the spaces file", () => {
  it("reads the rules and the spaces, with sizes in bytes", () => {
    const c = parseConfig(SPACES);
    expect(c.policy).toEqual({ links: { maxDays: 90, passwordRequired: true }, bin: { keepDays: 30 }, personal: { quota: 20 * 1024 ** 3 } });
    expect(c.spaces).toEqual([
      {
        name: "Finance",
        kind: "team",
        description: null,
        quota: 100 * 1024 ** 3,
        members: [
          { group: "finance", role: "editor" },
          { group: "finance-leads", role: "manager" },
        ],
        disabled: false,
      },
      {
        name: "Northwind rollout",
        kind: "project",
        description: "The Northwind customer rollout.",
        quota: 20 * 1024 ** 3,
        members: [
          { group: "project-northwind", role: "editor" },
          { group: "everyone", role: "viewer" },
        ],
        disabled: false,
      },
    ]);
  });

  it("reads the example the repository ships", () => {
    const c = parseConfig(readFileSync(new URL("../config/files.yaml", import.meta.url), "utf8"));
    expect(c.spaces.map((s) => [s.name, s.disabled])).toEqual([
      ["Finance", false],
      ["Northwind rollout", false],
      ["Office move 2025", true],
    ]);
  });

  it("has safe rules when the file sets none", () => {
    expect(parseConfig("")).toEqual({ policy: DEFAULT_POLICY, spaces: [] });
    expect(parseConfig("spaces: [{ name: Office move }]").policy.links).toEqual({ maxDays: 90, passwordRequired: true });
  });

  it.each([
    ["domains: []", "The file: unknown domains; it takes links, bin, personal, spaces."],
    ["spaces: {}", "spaces must be a list."],
    ["spaces:\n  - name: a/b", 'spaces[0].name is required: up to 64 characters, without / \\ : * ? " < > |.'],
    ["spaces:\n  - name: Sales\n  - name: sales", "spaces[1].name: sales is in the file twice."],
    ["spaces:\n  - name: Sales\n    group: sales", "spaces[0] (Sales): unknown group; it takes name, kind, description, quota, members, disabled."],
    ["spaces:\n  - name: Sales\n    kind: personal", "spaces[0] (Sales).kind is team or project."],
    ["spaces:\n  - name: Sales\n    quota: 10KB", "spaces[0] (Sales).quota is a size from 1MB to 1024TB, such as 100GB."],
    ["spaces:\n  - name: Sales\n    members: [{ group: sales, role: owner }]", "spaces[0] (Sales).members[0].role is viewer, editor or manager."],
    ["spaces:\n  - name: Sales\n    members: [{ role: viewer }]", "spaces[0] (Sales).members[0].group is an Identity group's name, such as finance."],
    [
      "spaces:\n  - name: Sales\n    members: [{ group: sales, role: viewer }, { group: Sales, role: editor }]",
      "spaces[0] (Sales).members[1].group: Sales is a member of this space twice.",
    ],
    ["links:\n  maxDays: 0", "links.maxDays is a whole number of days from 1 to 365."],
    ["links:\n  maxDays: 400", "links.maxDays is a whole number of days from 1 to 365."],
    ["links:\n  passwordRequired: yes please", "links.passwordRequired is true or false."],
    ["links:\n  expire: true", "links: unknown expire; it takes maxDays, passwordRequired."],
    ["bin:\n  keepDays: 1.5", "bin.keepDays is a whole number of days from 1 to 3650."],
    ["versions:\n  keepDays: 90", "The file: unknown versions; it takes links, bin, personal, spaces."],
  ])("refuses %j", (text, message) => {
    expect(() => parseConfig(text)).toThrow(message);
  });

  it("keeps the last good version when the file breaks, and applies the fix", () => {
    const path = join(mkdtempSync(join(tmpdir(), "files-config-")), "files.yaml");
    writeFileSync(path, SPACES);
    const applied: number[] = [];
    const file = watchConfig(path, (c) => void applied.push(c.spaces.length), { everyMs: 3_600_000 });
    expect(file.state).toMatchObject({ spaces: 2, error: null, text: SPACES });
    writeFileSync(path, "spaces: [");
    file.read();
    expect(file.state.error).toMatch(/^Not valid YAML/);
    expect(file.state).toMatchObject({ spaces: 2, text: SPACES });
    writeFileSync(path, "spaces:\n  - name: Sales\n");
    file.read();
    expect(file.state).toMatchObject({ spaces: 1, error: null });
    expect(applied).toEqual([2, 1]);
    file.stop();
  });
});
