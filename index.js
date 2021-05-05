const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const fs = require("fs");
const semver = require("semver");

const repoInfo = async () => {
  const log = await simpleGit.default().log({ maxCount: 1 });
  const sha = log.latest.hash;

  const remotes = await simpleGit.default().getRemotes(true);
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

const versionFetch = (versionFile) => {
  const json = JSON.parse(fs.readFileSync(versionFile));
  const version = semver.parse(json.version);
  return version;
};

const versionSet = (versionFile, version) => {
  const json = JSON.parse(fs.readFileSync(versionFile));
  json.version = version;
  fs.writeFileSync(versionFile, JSON.stringify(slyFile, null, 2));
};

const prerelease = async () => {
  const versionFile = core.getInput("version-file", { required: true });
  const version = versionFetch(versionFile);

  const newVersion = semver.parse(semver.inc(version, "prerelease"));
  versionSet(versionFile, version.version);

  const title = `CI: Prerelease: ${newVersion.version}`;

  const versionCommit = await simpleGit.default().commit(title, versionFile);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(versionCommit)
  );

  const tag = await simpleGit.default().addTag(newVersion.version);
  console.log(`Created new tag: ${tag.name}`);

  // TODO: repo-token
  await simpleGit.default().push(["--follow-tags"]);
  await simpleGit.default().pushTags();

  return { version: newVersion };
};

const postrelease = async (org, repo) => {
  const versionFile = core.getInput("version-file", { required: true });
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const info = await octokit.repos.get({ owner: org, repo });
  const defaultBranch = info.data.default_branch;

  await simpleGit.default().fetch();
  await simpleGit.default().checkout(defaultBranch);

  const version = versionFetch(versionFile);
  const newVersion = semver.parse(semver.inc(version, "patch"));

  versionSet(versionFile, newVersion.version);

  const title = `CI: Postrelease: ${newVersion.version}`;

  const commit = await simpleGit.default().commit(title, versionFile);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(commit)
  );

  await simpleGit.default().push();

  return { version: newVersion };
};

// TODO: Handle PR
// TODO: Glob Up Commit Messages since last release
const draftRelease = async (org, repo, version) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const latestRelease = await octokit.repos.getLatestRelease({
    owner: org,
    repo,
  });
  // TODO: Maybe have to loop to find the last non-draft, non-prerelease release
  console.log("!!! latest release is", JSON.stringify(latestRelease));
  const { tag_name: tag } = latestRelease.data;

  const { all: logs } = await simpleGit
    .default()
    .log({ from: tag, to: version.version });

  console.log("!!! logs are", JSON.stringify(logs));

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: version.version,
    tag_name: version.version,
    draft: true,
    body: `
# Release ${version.version}:

Last released version: \`${tag}\`

## Changes since last release:
${logs.map((log) => {
  return `

<details>
  <summary>${log.hash.slice(0, 7)}: ${log.message}</summary>

  *By:* [${log.author_name}](mailto:${log.author_email})

  ${log.body}

</details>

`;
})}
`,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);
};

const run = async () => {
  await simpleGit.default().addConfig("user.name", "GitHub Action");
  await simpleGit
    .default()
    .addConfig("user.email", "github-action@users.noreply.github.com");

  const { organization, repo } = await repoInfo();

  const action = core.getInput("action", { required: true });

  switch (action) {
    case "prerelease": {
      const { version } = await prerelease();
      await draftRelease(organization, repo, version);
      break;
    }

    case "postrelease": {
      // Naively bumping version, but this is probably good...
      await postrelease(organization, repo);
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
};

(async () => {
  try {
    await run();
  } catch (e) {
    console.error(e);
    core.setFailed(e.message);
  }
})();
