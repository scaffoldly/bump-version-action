# setup-bootstrap action

This action fetches the GitHub organization and ensures Terraform Cloud is
initialized prior to running a `terraform plan`.

## Inputs

### `root-email`

**Required** [Root Email for your project](https://docs.scaffold.ly/getting-started/prerequisites#root-email)

### `terraform-cloud-token`

**Required** [Access Token to Terraform Cloud](https://docs.scaffold.ly/getting-started/prerequisites#terraform-cloud)

## Outputs

### `organization`

The GitHub/Terraform Cloud Organization name

## Example usage

```yaml
- uses: scaffoldly/setup-bootstrap@v1
  with:
    root-email: ${{ secrets.BOOTSTRAP_ROOT_EMAIL }}
  terraform-cloud-token: ${{ secrets.BOOTSTRAP_TERRAFORM_TOKEN }}
```
