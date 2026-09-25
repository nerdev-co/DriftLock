import { describe, expect, test } from "bun:test";
import { renderPerChangeComment, toPerChangeReviews } from "./perChangeReview";

describe("per-change review counts", () => {
  test("counts pending warnings even without breaking changes", () => {
    const reviews = toPerChangeReviews([
      { kind: "field_added", field: "email", breaking: false },
      { kind: "field_added", field: "name", breaking: false },
    ], ["email", "name"]);
    expect(renderPerChangeComment(reviews)).toContain("2 pending review");
    expect(renderPerChangeComment(reviews)).toContain("0 breaking");
  });

  test("excludes completed reviews from the pending count", () => {
    const reviews = toPerChangeReviews([
      { kind: "field_removed", field: "email", breaking: true },
      { kind: "field_added", field: "name", breaking: false },
      { kind: "field_added", field: "address", breaking: false },
    ], ["email", "name", "address"]);
    reviews[0].status = "approved";
    reviews[1].status = "rejected";
    expect(renderPerChangeComment(reviews)).toContain("1 pending review");
    expect(renderPerChangeComment(reviews)).toContain("1 breaking");
  });
});
