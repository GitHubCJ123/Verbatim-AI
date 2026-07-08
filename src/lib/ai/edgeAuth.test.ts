import { describe, expect, it } from "vitest";
import { EDGE_APP_SECRET_HEADER, edgeAppSecretHeaders, serializeDurationMs } from "./edgeAuth";

describe("edge auth helpers", () => {
  it("omits the app attestation header when no secret is configured", () => {
    expect(edgeAppSecretHeaders("   ")).toEqual({});
  });

  it("adds the app attestation header when configured", () => {
    expect(edgeAppSecretHeaders(" deployed-secret ")).toEqual({
      [EDGE_APP_SECRET_HEADER]: "deployed-secret",
    });
  });

  it("serializes client recording duration for Edge Function caps", () => {
    expect(serializeDurationMs(123.6)).toBe("124");
    expect(serializeDurationMs(-3)).toBe("0");
    expect(serializeDurationMs(undefined)).toBeUndefined();
  });
});
