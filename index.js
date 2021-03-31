const core = require("@actions/core");
const github = require("@actions/github");
const simpleGit = require("simple-git");
const axios = require("axios");
const proc = require("child_process");
const openpgp = require("openpgp");
const fs = require("fs");
const semver = require("semver");
const immutable = require("immutable");

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
    semver.inc(version, rc ? "prerelease" : "patch")
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
// TODO: Skip if commit message is "Initial Whatever" (from repo template)
// TODO: Glob Up Commit Messages since last release
const draftRelease = async (org, repo, plan, files) => {
  const version = await slyVersion(true, true);
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
    async ([filename, contents]) => {
      const asset = await octokit.repos.uploadReleaseAsset({
        owner: org,
        repo,
        release_id: release.data.id,
        name: filename,
        data: contents,
      });

      console.log(
        `Uploaded planfile to release ${release.data.name}: ${asset.data.url}`
      );
    }
  );

  await Promise.all(assetUploadPromises);
};

const fetchRelease = async (org, repo) => {
  const version = await slyVersion();
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
  console.log(
    `Found ${releaseAssets.data.length} release assets`,
    JSON.stringify(releaseAssets) // TODO: Remove this
  );
  const assetPromises = releaseAssets.data.map(async (releaseAsset) => {
    console.log(
      `Downloading release asset: ${releaseAsset.name} from url ${releaseAsset.browser_download_url}`
    );
    const { data } = await axios.default.get(
      releaseAsset.browser_download_url,
      {
        headers: {
          Authorization: `Bearer ${repoToken}`,
          "User-Agent": "Scaffoldly Bootstrap Action",
          "Content-Type": releaseAsset.content_type,
        },
      }
    );
    return { [releaseAsset.name]: data };
  });
  const assets = await Promise.all(assetPromises);

  return {
    releaseId: release.data.id,
    version: version.version,
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
    const p = proc.exec(command, (error, stdout) => {
      if (error) {
        reject(new Error(cleanseExecOutput(stdout)));
        return;
      }
      resolve(cleanseExecOutput(stdout));
    });
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stdout); // Pipe stderr to stdout too
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
  const planfile = fs.readFileSync("./planfile");
  return { plan, planfile };
};

const terraformApply = async (planfile) => {
  const version = await slyVersion(true);

  fs.writeFileSync("./planfile", planfile);
  let output;
  try {
    const command = `terraform apply -no-color planfile`;
    output = await exec(command);
  } catch (e) {
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

  return { apply: output };
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

const decrypt = async (text) => {
  const terraformCloudToken = core.getInput("terraform-cloud-token");

  const message = openpgp.Message.fromText(text);
  const stream = await openpgp.decrypt({
    message,
    passwords: [terraformCloudToken],
  });
  const decrypted = await openpgp.stream.readToEnd(stream);

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
      const { plan, planfile } = await terraformPlan();
      const encrypted = await encrypt(planfile); // TODO Switch back to encrypted planfile
      await draftRelease(organization, repo, plan, {
        "planfile.pgp": encrypted,
        planfile, // TODO: Remove this
      });
      break;
    }

    case "apply": {
      const { files } = await fetchRelease(organization, repo);
      if (!files || !files["planfile.pgp"]) {
        // Handle release that is created post-apply
        console.log(
          "No planfile on this release, so nothing to do here! Exiting..."
        );
        return;
      }
      const encrypted = files["planfile.pgp"];
      const planfile = await decrypt(encrypted);
      await terraformApply(planfile);
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
    core.setFailed(e.message);
  }
})();
