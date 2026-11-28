import { describe, expect, it } from "vitest";
import { apiUrlError } from "./apiUrlCheck";

describe("apiUrlError", () => {
  it("accepts an empty apiUrl (same origin) and https://", () => {
    expect(apiUrlError("")).toBeNull();
    expect(apiUrlError("https://planning.example.com")).toBeNull();
    expect(apiUrlError("https://10.0.0.5:8443")).toBeNull();
  });

  it("accepts http:// to the local machine", () => {
    for (const url of [
      "http://localhost:8080",
      "http://LOCALHOST",
      "http://planner.localhost",
      "http://127.0.0.1:8181",
      "http://127.1.2.3",
      "http://[::1]:8080",
    ]) {
      expect(apiUrlError(url), url).toBeNull();
    }
  });

  it("refuses http:// to any other host", () => {
    for (const url of [
      "http://planning.example.com",
      "http://192.168.1.10:8080",
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
    ]) {
      expect(apiUrlError(url), url).toMatch(/unencrypted http:\/\//);
    }
  });

  it("refuses other schemes and invalid URLs", () => {
    expect(apiUrlError("ws://planning.example.com")).toMatch(/must start with https:\/\//);
    expect(apiUrlError("planning.example.com")).toMatch(/not a valid URL/);
  });
});
