const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");
const proc = require("child_process");
const openpgp = require("openpgp");
const fs = require("fs");
const semver = require("semver");
const immutable = require("immutable");
const { Readable } = require("stream");

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

const slyVersionFetch = () => {
  const slyFile = JSON.parse(fs.readFileSync(SLY_FILE));
  const version = semver.parse(slyFile.version);
  return version;
};

const slyVersionSet = (version) => {
  const slyFile = JSON.parse(fs.readFileSync(SLY_FILE));
  slyFile.version = version;
  fs.writeFileSync(SLY_FILE, JSON.stringify(slyFile));
};

const prerelease = async () => {
  const version = slyVersionFetch();

  const newVersion = semver.parse(semver.inc(version, "prerelease"));

  slyVersionSet(version.version);

  const title = `CI: Prerelease: ${newVersion.version}`;

  const versionCommit = await simpleGit.default().commit(title, SLY_FILE);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(versionCommit)
  );

  const tag = await simpleGit.default().addTag(newVersion.version);
  console.log(`Created new tag: ${tag.name}`);

  await simpleGit.default().push(["--follow-tags"]);
  await simpleGit.default().pushTags();

  return { version: newVersion };
};

const postrelease = async (org, repo) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const info = await octokit.repos.get({ owner: org, repo });
  const defaultBranch = info.data.default_branch;

  await simpleGit.default().fetch();
  await simpleGit.default().checkout(defaultBranch);

  const version = slyVersionFetch();
  const newVersion = semver.parse(semver.inc(version, "patch"));

  slyVersionSet(newVersion.version);

  const title = `CI: Postrelease: ${newVersion.version}`;

  const commit = await simpleGit.default().commit(title, SLY_FILE);
  console.log(
    `Committed new version: ${newVersion.version}`,
    JSON.stringify(commit)
  );

  await simpleGit.default().push();

  return { version: newVersion };
};

// TODO: Handle PR -- Plan only as PR Comment
// TODO: Skip if commit message is "Initial Whatever" (from repo template)
// TODO: Glob Up Commit Messages since last release
const draftRelease = async (org, repo, version, plan, files) => {
  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: version.version,
    tag_name: version.version,
    draft: true,
    body: `
The following plan was created for ${version.version}:

\`\`\`
${plan}
\`\`\`
`,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);

  const assetUploadPromises = Object.entries(files).map(
    async ([filename, path]) => {
      const asset = await octokit.repos.uploadReleaseAsset({
        owner: org,
        repo,
        release_id: release.data.id,
        name: filename,
        data: fs.readFileSync(path),
      });

      console.log(
        `Uploaded planfile to release ${release.data.name}: ${asset.data.url}`
      );
    }
  );

  await Promise.all(assetUploadPromises);
};

const fetchRelease = async (org, repo) => {
  const version = slyVersionFetch();
  if (version.prerelease.length === 0) {
    throw new Error(
      `Unable to apply, version not a prerelease: ${version.version}`
    );
  }

  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.getReleaseByTag({
    owner: org,
    repo,
    tag: version.version,
  });
  if (!release || !release.data || !release.data.id) {
    throw new Error(`Unable to find a release for tag: ${version.version}`);
  }

  console.log(
    `Found release ID ${release.data.id} for version ${version.version}`
  );

  const releaseAssets = await octokit.repos.listReleaseAssets({
    owner: org,
    repo,
    release_id: release.data.id,
  });
  console.log(`Found ${releaseAssets.data.length} release assets`);
  const assetPromises = releaseAssets.data.map(async (releaseAsset) => {
    const { url } = await octokit.repos.getReleaseAsset({
      owner: org,
      repo,
      asset_id: releaseAsset.id,
      headers: { accept: "application/octet-stream" },
    });
    console.log(
      `Downloading release asset: ${releaseAsset.name} from url ${url}`
    );
    const { data } = await axios.default.get(url, {
      responseType: "arraybuffer",
      responseEncoding: "binary",
    });

    const path = `./${releaseAsset.name}`;
    fs.writeFileSync(path, data);

    return { [releaseAsset.name]: path };
  });
  const assets = await Promise.all(assetPromises);

  return {
    releaseId: release.data.id,
    version,
    files: immutable.merge({}, ...assets),
  };
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

const cleanseExecOutput = (output) => {
  let cleansed = output;
  // Remove GitHub enrichment of output
  cleansed = cleansed.replace(/^::debug::.*\n?/gm, "");
  cleansed = cleansed.replace(/^::set-output.*\n?/gm, "");
  return cleansed;
};

const exec = (command) => {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const parts = command.split(" ");
    const p = proc.spawn(parts[0], parts.slice(1));

    p.on("error", (err) => {
      reject(err);
    });

    p.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({
          stdout: cleanseExecOutput(stdout),
          stderr: cleanseExecOutput(stderr),
        });
        return;
      }
      reject(new Error(`Command '${command}' exited with code ${code}`));
    });

    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stdout); // Pipe stderr to stdout too

    p.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`;
    });
    p.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`;
    });
  });
};

const terraformInit = async (organization) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const command = `terraform init -backend-config="hostname=app.terraform.io" -backend-config="organization=${organization}" -backend-config="token=${terraformCloudToken}"`;

  await exec(command);
};

const terraformPlan = async (planfile) => {
  const command = `terraform plan -no-color -out ${planfile}`;
  const { stdout: plan } = await exec(command);
  //TODO Encrypt
  return { plan, planfile };
};

const terraformApply = async (org, repo, planfile) => {
  let version = semver.parse(semver.inc(slyVersionFetch(), "patch"));

  //TODO Decrypt
  let output;
  try {
    const command = `terraform apply -no-color ${planfile}`;
    const { stdout } = await exec(command);
    output = stdout;
  } catch (e) {
    console.log(
      "Error while applying, setting the action as failed, but continuing for housecleaning..."
    );
    core.setFailed(e);
    output = e.message;
  }

  const repoToken = core.getInput("repo-token");
  const octokit = github.getOctokit(repoToken);

  const release = await octokit.repos.createRelease({
    owner: org,
    repo,
    name: version.version,
    tag_name: version.version,
    body: `
The following was applied for ${version.version}:

\`\`\`
${output}
\`\`\`
`,
  });

  console.log(`Created release: ${release.data.name}: ${release.data.url}`);

  return { apply: output, version };
};

const encrypt = async (text) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");
  const message = openpgp.Message.fromText(stream);
  const stream = await openpgp.encrypt({
    message,
    passwords: [terraformCloudToken],
  });
  const encrypted = await openpgp.stream.readToEnd(stream);

  return encrypted;
};

const decrypt = async (text) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const message = await openpgp.readMessage({ armoredMessage: text });
  const { data: decrypted } = await openpgp.decrypt({
    message,
    passwords: [terraformCloudToken],
    format: "binary",
  });

  return decrypted;
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
      const { version } = await prerelease();
      const { plan, planfile } = await terraformPlan("./planfile");
      await draftRelease(organization, repo, version, plan, {
        planfile,
      });
      break;
    }

    case "apply": {
      const { files, version } = await fetchRelease(organization, repo);
      if (!files || files.length === 0) {
        throw new Error(`No release assets on version ${version}`);
      }
      await terraformApply(organization, repo, files["planfile"]);
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
