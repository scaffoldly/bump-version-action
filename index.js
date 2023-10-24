const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const fs = require("fs");
const semver = require("semver");
const axios = require("axios");

const gitClient = simpleGit.default();
const GITHUB_RUN_ATTEMPT = parseInt(process.env.GITHUB_RUN_ATTEMPT || "1");

const repoInfo = async () => {
  const log = await gitClient.log({ maxCount: 1 });
  const sha = log.latest.hash;

  const remotes = await gitClient.getRemotes(true);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { pathname } = new URL(origin.refs.push);
  if (!pathname) {
    throw new Error(`Unable to extract pathname from ${origin.refs.push}`);
  }

  const organization = pathname.split("/")[1];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${pathname}`);
  }

  const repo = pathname.split("/")[2];
  if (!repo) {
    throw new Error(`Unable to extract repo from ${pathname}`);
  }

  const info = { organization, repo, sha };

  console.log("Repo Info: ", JSON.stringify(info, null, 2));

  return info;
};

const commitMessagePrefix = (message) => {
  const prefix = core.getInput("commit-message-prefix", {
    required: false,
  });
  if (!prefix) {
    return `🤖 ${message}`;
  }

  return `🤖 ${prefix} ${message}`;
};

const versionFetch = (versionFile) => {
  const json = JSON.parse(fs.readFileSync(versionFile));
  const version = semver.parse(json.version);
  return version;
};

const versionSet = (versionFile, version) => {
  const json = JSON.parse(fs.readFileSync(versionFile));
  json.version = version;
  fs.writeFileSync(versionFile, JSON.stringify(json, null, 2));
};

const prerelease = async (org, repo) => {
  const versionFile = core.getInput("version-file", { required: true });
  const tagPrefix = core.getInput("tag-prefix", { required: false }) || "";
  const pushFlags = GITHUB_RUN_ATTEMPT !== 1 ? ["--force"] : [];

  const version = versionFetch(versionFile);

  console.log("Current version:", version.version);

  const newVersion = semver.parse(
    semver.inc(semver.parse(version.version), "prerelease")
  );
  versionSet(versionFile, newVersion.version);

  console.log("New version:", newVersion.version);

  const title = commitMessagePrefix(`CI: Prerelease: ${newVersion.version}`);

  await gitClient.add(".");

  const versionCommit = await gitClient.commit(title, undefined, {
    "--no-edit": true,
    "--no-verify": true,
    "--amend": true,
  });
  console.log(
    `Committed version: ${newVersion.version}`,
    JSON.stringify(versionCommit)
  );

  const tag = await gitClient.addTag(`${tagPrefix}${newVersion.version}`);
  console.log(`Created new tag: ${tag.name}`);

  await gitClient.push(["--follow-tags"]);
  await gitClient.pushTags(pushFlags, { "--force": true });
  return { version: newVersion };
};

const postrelease = async (org, repo, sha) => {
  const versionFile = core.getInput("version-file", { required: true });
  const tagPrefix = core.getInput("tag-prefix", { required: false }) || "";
  const repoToken = core.getInput("repo-token");
  const majorTag = core.getInput("major-tag");

  const octokit = github.getOctokit(repoToken);

  await gitClient.fetch();
  await gitClient.checkout(sha);
  const tagVersion = versionFetch(versionFile);
  const newTagVersion = semver.parse(
    semver.inc(semver.parse(tagVersion.version), "patch")
  );

  const tag = await gitClient.addTag(`${tagPrefix}${newTagVersion.version}`);
  console.log(`Created new tag: ${tag.name}`);

  if (majorTag) {
    const superTag = `v${newTagVersion.major}`;
    await gitClient.raw([
      "tag",
      "-f",
      superTag,
      `${tagPrefix}${newTagVersion.version}`,
    ]);
    console.log(`Created super tag: ${superTag}`);
    await gitClient.pushTags(["--force"]);
  } else {
    await gitClient.pushTags();
  }

  const releaseBranch = core.getInput("release-branch", { required: false });

  if (releaseBranch) {
    const release = await octokit.repos.createRelease({
      owner: org,
      repo,
      name: newTagVersion.version,
      tag_name: newTagVersion.version,
      draft: false,
      body: `
HOTFIX: \`${tagVersion.version}\` to \`${newTagVersion.version}\`
`,
    });

    console.log(`Created release: ${release.data.name}: ${release.data.url}`);
  } else {
    const release = await octokit.repos.getReleaseByTag({
      owner: org,
      repo,
      tag: tagVersion.version,
    });

    await octokit.repos.updateRelease({
      owner: org,
      repo,
      release_id: release.data.id,
      name: newTagVersion.version,
      tag_name: newTagVersion.version,
    });

    console.log(
      `Updated release ${release.data.id} on tag ${tagVersion.version} to tag: ${newTagVersion.version}`
    );
  }

  const info = await octokit.repos.get({ owner: org, repo });
  let defaultBranch = info.data.default_branch;

  if (releaseBranch) {
    defaultBranch = releaseBranch;
  }

  console.log("Updating version on branch:", releaseBranch);

  await gitClient.checkout(defaultBranch);

  const version = versionFetch(versionFile);
  console.log("Current version", version.version);

  const newVersion = semver.parse(
    semver.inc(semver.parse(version.version), "patch")
  );
  console.log("New version", newVersion.version);

  versionSet(versionFile, newVersion.version);

  const title = commitMessagePrefix(`CI: Postrelease: ${newVersion.version}`);

  const commit = await gitClient.commit(title, versionFile, {
    "--no-verify": true,
  });
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(commit)
  );

  await gitClient.push();

  versionSet(versionFile, newTagVersion.version);

  return { version: newVersion };
};

const createLogMessages = (
  logs,
  org,
  repo,
  fromTag,
  options = { links: true, messages: true, authors: true }
) => {
  let body = logs
    .map((log) => {
      return `
 - ${log.hash.slice(0, 7)}: ${
        options.messages ? `**${log.message.split("\n")[0]}** ` : ""
      }${options.authors ? `(${log.author_name}) ` : ""}${
        options.links
          ? `[_[compare](https://github.com/${org}/${repo}/compare/${fromTag}...${log.hash})_] `
          : ``
      }`;
    })
    .join("\n");

  if (
    body.length >= 20000 &&
    options.links &&
    options.authors &&
    options.messages
  ) {
    console.warn("Body is long. Skipping links...");
    body = createLogMessages(logs, org, repo, fromTag, {
      links: false,
      authors: true,
      messages: true,
    });
  }

  if (
    body.length >= 20000 &&
    !options.links &&
    options.authors &&
    options.messages
  ) {
    console.warn("Body is long. Skipping messages...");
    body = createLogMessages(logs, org, repo, fromTag, {
      links: false,
      authors: true,
      messages: false,
    });
  }

  if (
    body.length >= 20000 &&
    !options.links &&
    options.authors &&
    !options.messages
  ) {
    console.warn("Body is long. Skipping authors...");
    body = createLogMessages(logs, org, repo, fromTag, {
      links: false,
      authors: false,
      messages: false,
    });
  }

  if (
    body.length >= 20000 &&
    !options.links &&
    !options.authors &&
    !options.message
  ) {
    body = `Unable to summarize release`;
  }

  return body;
};

// TODO: Handle PR
// TODO: Glob Up Commit Messages since last release
const draftRelease = async (org, repo, version, sha) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  await gitClient.fetch(["--unshallow"]);

  let fromTag;
  try {
    const latestRelease = await octokit.repos.getLatestRelease({
      owner: org,
      repo,
    });
    fromTag = latestRelease.data.tag_name;
  } catch (e) {
    console.warn("Unable to find latest release:", e.message);
    fromTag = (await gitClient.log()).all.slice(-1)[0].hash;
  }

  // const info = await octokit.repos.get({ owner: org, repo });
  // const defaultBranch = info.data.default_branch;

  const { all: logs } = await simpleGit
    .default()
    .log({ from: fromTag, to: sha, "--first-parent": true });

  let body = createLogMessages(logs, org, repo, fromTag);

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: version.version,
    tag_name: version.version,
    draft: true,
    body: `
# Release ${version.version}:

## Commits since [${fromTag}](https://github.com/${org}/${repo}/compare/${fromTag}...${version.version}):

${body}
`,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);
};

const event = (org, repo, action) => {
  const dnt = core.getInput("dnt", { required: false });
  if (dnt) {
    return;
  }

  axios.default
    .post(
      `https://api.segment.io/v1/track`,
      {
        userId: org,
        event: action,
        properties: { script: "bump-version-action" },
        context: { repo },
      },
      { auth: { username: "RvjEAi2NrzWFz3SL0bNwh5yVwrwWr0GA", password: "" } }
    )
    .then(() => {})
    .catch((error) => {
      console.error("Event Log Error", error);
    });
};

const run = async () => {
  const action = core.getInput("action", { required: true });
  const { organization, repo, sha } = await repoInfo();

  event(organization, repo, action);

  await gitClient.addConfig("user.name", "GitHub Action");
  await simpleGit
    .default()
    .addConfig("user.email", "github-action@users.noreply.github.com");

  switch (action) {
    case "prerelease": {
      const { version } = await prerelease(organization, repo);
      await draftRelease(organization, repo, version, sha);
      break;
    }

    case "postrelease": {
      // Naively bumping version, but this is probably good...
      await postrelease(organization, repo, sha);
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
};

(async () => {
  if (GITHUB_RUN_ATTEMPT !== 1) {
    console.log(`Skipping since this is run ${GITHUB_RUN_ATTEMPT}...`);
    return;
  }
  try {
    await run();
  } catch (e) {
    console.error(e);
    core.setFailed(e.message);
  }
})();
