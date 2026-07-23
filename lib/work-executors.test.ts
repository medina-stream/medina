import { beforeEach, describe, expect, test } from "bun:test";

import { clearWorkExecutors, listWorkExecutors, registerWorkExecutor } from "./work-executors";

beforeEach(clearWorkExecutors);

describe("work executor registry", () => {
  test("orders executors by claim order and rejects duplicate names", () => {
    const execute = async () => true;
    registerWorkExecutor({ claimOrder: 10, execute, work: { name: "ingests", version: "1" } });
    registerWorkExecutor({ claimOrder: 0, execute, work: { name: "triage", version: "1" } });

    expect(listWorkExecutors().map((executor) => executor.work.name)).toEqual(["triage", "ingests"]);
    expect(() => registerWorkExecutor({ claimOrder: 20, execute, work: { name: "triage", version: "2" } })).toThrow("already registered");
  });
});
