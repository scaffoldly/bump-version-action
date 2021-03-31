const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");
const proc = require("child_process");
const openpgp = require("openpgp");
const fs = require("fs");
const semver = require("semver");

const SLY_FILE = "./sly.json";

const repoInfo = async () => {
  const rootEmail = core.getInput("root-email");
  await simpleGit
    .default()
    .addConfig("user.name", "Scaffoldly Bootstrap Action");
  await simpleGit.default().addConfig("user.email", rootEmail);

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

  return { organization, repo, sha };
};

const slyVersion = async (increment = false, rc = false) => {
  const slyFile = JSON.parse(fs.readFileSync(SLY_FILE));
  const version = semver.parse(slyFile.version);
  if (!increment) {
    return version;
  }

  const newVersion = semver.parse(
    semver.inc(version, rc ? "prerelease" : "minor")
  );
  slyFile.version = newVersion.version;

  const title = `${rc ? "Prerelease" : "Release"}: ${newVersion.version}`;

  fs.writeFileSync(SLY_FILE, JSON.stringify(slyFile));
  const versionCommit = await simpleGit
    .default()
    .commit(`CI: ${title}`, SLY_FILE);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(versionCommit)
  );

  const tag = await simpleGit.default().addTag(newVersion.version);
  console.log(`Created new tag: ${tag.name}`);

  await simpleGit.default().push(["--follow-tags"]);
  await simpleGit.default().pushTags();

  return semver.parse(newVersion);
};

// TODO: Handle PR -- Plan only as PR Comment
// TODO: Skip if commit message is "Initial Release"
const draftRelease = async (org, repo, plan, planfile) => {
  const version = await slyVersion(true, true);
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: version.version,
    tag_name: version.version,
    draft: true,
    prerelease: true,
    body: `
The following plan was created for ${version.version}:

\`\`\`
${plan}
\`\`\`
`,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);

  const asset = await octokit.repos.uploadReleaseAsset({
    owner: org,
    repo,
    release_id: release.data.id,
    name: "planfile.pgp",
    data: planfile,
  });

  console.log(
    `Uploaded planfile to release ${release.data.name}: ${asset.data.url}`
  );
};

const terraformPost = async (url, payload) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  try {
    const { status, data } = await axios.default.post(url, payload, {
      headers: {
        Authorization: `Bearer ${terraformCloudToken}`,
        "Content-Type": "application/vnd.api+json",
      },
    });

    return { status, data };
  } catch (e) {
    // ignore this type of response so our org/workspace creation is idempotent
    // {"errors":[{"status":"422","title":"invalid attribute","detail":"Name has already been taken","source":{"pointer":"/data/attributes/name"}}]}
    if (
      !e.response ||
      e.response.status !== 422 ||
      !e.response.data ||
      !e.response.data.errors ||
      e.response.data.errors.length !== 1 ||
      !e.response.data.errors[0] ||
      !e.response.data.errors[0].source ||
      !e.response.data.errors[0].source.pointer ||
      e.response.data.errors[0].source.pointer !== "/data/attributes/name"
    ) {
      console.error("Error posting to Terraform Cloud", e.message);
      throw e;
    }

    const { status, data } = e.response;

    return { status, data };
  }
};

const createTerraformOrganization = async (organization) => {
  const rootEmail = core.getInput("root-email");

  const { status, data } = await terraformPost(
    "https://app.terraform.io/api/v2/organizations",
    {
      data: {
        type: "organizations",
        attributes: {
          name: organization,
          email: rootEmail,
        },
      },
    }
  );

  console.log(`[${status}] Create Org Response: ${JSON.stringify(data)}`);
};

const createTerraformWorkspace = async (organization, workspace) => {
  const { status, data } = await terraformPost(
    `https://app.terraform.io/api/v2/organizations/${organization}/workspaces`,
    {
      data: {
        type: "workspaces",
        attributes: {
          name: workspace,
          operations: false,
        },
      },
    }
  );

  console.log(`[${status}] Create Workspace Response: ${JSON.stringify(data)}`);
};

const exec = (command) => {
  return new Promise((resolve, reject) => {
    const p = proc.exec(command, (error, stdout) => {
      if (error) {
        reject(new Error(error));
        return;
      }
      resolve(stdout);
    });
    p.stdout.on("data", (data) => {
      process.stdout.write(data);
    });
    p.stderr.on("data", (data) => {
      process.stderr.write(data);
    });
  });
};

const terraformInit = async (organization) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const command = `terraform init -backend-config="hostname=app.terraform.io" -backend-config="organization=${organization}" -backend-config="token=${terraformCloudToken}"`;

  await exec(command);
};

const terraformPlan = async () => {
  const command = `terraform plan -no-color -out planfile`;
  const plan = await exec(command);
  const planfile = fs.readFileSync("planfile");
  return { plan, planfile };
};

const encrypt = async (text) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const message = openpgp.Message.fromText(text);
  const stream = await openpgp.encrypt({
    message,
    passwords: [terraformCloudToken],
  });
  const encrypted = await openpgp.stream.readToEnd(stream);

  return encrypted;
};

const run = async () => {
  const { organization, repo } = await repoInfo();
  core.setOutput("organization", organization);

  await createTerraformOrganization(organization);
  await createTerraformWorkspace(organization, repo);
  await terraformInit(organization);

  const action = core.getInput("action");

  switch (action) {
    case "plan": {
      // TODO: lint planfile (terraform show -json planfile)
      const { plan, planfile } = await terraformPlan();
      const encrypted = await encrypt(planfile);
      await draftRelease(organization, repo, plan, encrypted);
      break;
    }

    default:
      console.error("Unknown action", action);
  }
};

(async () => {
  try {
    await run();
  } catch (e) {
    core.setFailed(e.message);
  }
})();
