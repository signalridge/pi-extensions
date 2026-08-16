import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNpmrc,
  buildPublishCommandArgs,
  parsePublishWithTokenArgs,
  validateToken,
} from "./publish-with-token.mjs";

const fixtureToken = "fixture-token-value";

test("removes the positional token before constructing publish argv", () => {
  const parsed = parsePublishWithTokenArgs([
    fixtureToken,
    "--package=pi-herdr-state",
    "--tag",
    "latest",
    "--include-experimental",
    "--dry-run",
  ]);

  assert.equal(parsed.tokenSource, "argument");
  assert.equal(parsed.token, fixtureToken);
  assert.deepEqual(parsed.publishArgs, [
    "--package=pi-herdr-state",
    "--tag",
    "latest",
    "--include-experimental",
    "--dry-run",
  ]);
  const childArgs = buildPublishCommandArgs(parsed.publishArgs);
  assert.deepEqual(childArgs, ["scripts/publish-packages.mjs", "--bootstrap", ...parsed.publishArgs]);
  assert.equal(childArgs.includes(fixtureToken), false);
});

test("requires exactly one explicit package selection for token bootstrap", () => {
  assert.throws(() => parsePublishWithTokenArgs([fixtureToken, "--dry-run"]), /exactly one explicit package selection/);
  assert.throws(
    () => parsePublishWithTokenArgs([fixtureToken, "--packages=pi-one,pi-two"]),
    /exactly one explicit package selection/,
  );
  assert.deepEqual(parsePublishWithTokenArgs(["--token-stdin", "--package=pi-one", "--dry-run"]).publishArgs, [
    "--package=pi-one",
    "--dry-run",
  ]);
});

test("strips --token-stdin and rejects wrapper token options in publish argv", () => {
  const parsed = parsePublishWithTokenArgs(["--token-stdin", "--package=pi-one", "--tag=latest", "--dry-run"]);
  assert.deepEqual(parsed, {
    tokenSource: "stdin",
    publishArgs: ["--package=pi-one", "--tag=latest", "--dry-run"],
  });

  assert.throws(
    () => parsePublishWithTokenArgs([fixtureToken, "--package=pi-one", "--token=hidden-value"]),
    (error) => {
      assert.match(error.message, /usage/);
      assert.doesNotMatch(error.message, /hidden-value/);
      return true;
    },
  );
});

test("validates token input and creates only the expected npmrc entries", () => {
  for (const invalid of ["", "has whitespace", "has\nnewline"]) {
    assert.throws(() => validateToken(invalid), /npm token/);
  }

  assert.equal(
    buildNpmrc(fixtureToken),
    "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=fixture-token-value\n",
  );
});
