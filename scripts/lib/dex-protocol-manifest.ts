import { canonicalSha256 } from './dex-census'
import { z } from 'zod'

export const DEX_PROTOCOL_MANIFEST_SCHEMA_VERSION = 1 as const

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const artifactSchema = z
  .object({
    artifact_id: z.string().min(1),
    official_url: z.string().refine(isHttpsUrl, 'official_url must use HTTPS'),
    repository: z.string().refine(isHttpsUrl, 'repository must use HTTPS'),
    git_commit: z.string().regex(FULL_GIT_SHA),
    path: z.string().min(1),
    content_sha256: z.string().regex(SHA256),
    license: z.enum(['MIT', 'BUSL-1.1']),
    usage: z.enum(['reference_only', 'vendored']),
  })
  .strict()

const contractSchema = z
  .object({
    role: z.enum(['event_emitter', 'data_store', 'synthetics_reader', 'diamond']),
    address: z.string().regex(EVM_ADDRESS),
    event_source: z.boolean(),
    address_artifact_id: z.string().min(1),
    abi_artifact_id: z.string().min(1).nullable(),
  })
  .strict()

const epochSchema = z
  .object({
    version_id: z.string().min(1),
    start_block: z.number().int().nonnegative().nullable(),
    end_block: z.number().int().nonnegative().nullable(),
    contracts: z.array(contractSchema).min(1),
  })
  .strict()

const lifecycleEvidenceSchema = z
  .object({
    claim: z.string().min(1),
    official_url: z.string().refine(isHttpsUrl, 'official_url must use HTTPS'),
  })
  .strict()

const deploymentSchema = z
  .object({
    deployment_id: z.string().min(1),
    protocol: z.enum(['gmx', 'gtrade']),
    chain: z
      .object({
        namespace: z.literal('eip155'),
        chain_id: z.number().int().positive(),
        network: z.string().min(1),
      })
      .strict(),
    lifecycle_status: z.enum(['active', 'historical', 'legacy', 'unverified']),
    status_as_of: z.string().refine(isCanonicalTimestamp, 'status_as_of must be canonical ISO'),
    upgrade_model: z.enum(['modular_contracts', 'diamond']),
    verification_state: z.enum(['draft', 'verified']),
    blocking_reasons: z.array(z.string().min(1)),
    epochs: z.array(epochSchema).min(1),
    decoder: z
      .object({
        owner: z.string().min(1).nullable(),
        required_fact_families: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    finality_policy: z
      .object({
        confirmations: z.number().int().nonnegative(),
        reorg_lookback_blocks: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    evidence: z.array(lifecycleEvidenceSchema).min(1),
  })
  .strict()

const manifestSchema = z
  .object({
    schema_version: z.literal(DEX_PROTOCOL_MANIFEST_SCHEMA_VERSION),
    evidence_as_of: z.string().refine(isCanonicalTimestamp, 'evidence_as_of must be canonical ISO'),
    purpose: z.literal('deployment_evidence_only'),
    artifacts: z.array(artifactSchema).min(1),
    non_evm_exemptions: z.array(
      z
        .object({
          protocol: z.literal('hyperliquid'),
          acquisition_mode: z.literal('hypercore_node_s3'),
          synthetic_census_chain_id: z.literal(999),
          reason: z.string().min(1),
        })
        .strict()
    ),
    deployments: z.array(deploymentSchema).min(1),
  })
  .strict()

export type DexProtocolArtifact = z.infer<typeof artifactSchema>
export type DexProtocolDeployment = z.infer<typeof deploymentSchema>
export type DexProtocolManifest = z.infer<typeof manifestSchema>

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function assertEpochs(deployment: DexProtocolDeployment): void {
  assertUnique(
    deployment.epochs.map((epoch) => epoch.version_id),
    `epoch in ${deployment.deployment_id}`
  )

  for (const epoch of deployment.epochs) {
    assertUnique(
      epoch.contracts.map((contract) => contract.role),
      `contract role in ${deployment.deployment_id}:${epoch.version_id}`
    )
    assertUnique(
      epoch.contracts.map((contract) => contract.address.toLowerCase()),
      `contract address in ${deployment.deployment_id}:${epoch.version_id}`
    )
    for (const contract of epoch.contracts) {
      if (/^0x0{40}$/i.test(contract.address)) {
        throw new Error(`zero contract address in ${deployment.deployment_id}:${epoch.version_id}`)
      }
    }
    if (epoch.end_block !== null && epoch.start_block === null) {
      throw new Error(`epoch end block requires start block: ${deployment.deployment_id}`)
    }
    if (
      epoch.start_block !== null &&
      epoch.end_block !== null &&
      epoch.start_block > epoch.end_block
    ) {
      throw new Error(`epoch start block exceeds end block: ${deployment.deployment_id}`)
    }
  }

  const boundedEpochs = deployment.epochs
    .filter((epoch) => epoch.start_block !== null)
    .sort((a, b) => a.start_block! - b.start_block!)
  for (let index = 1; index < boundedEpochs.length; index += 1) {
    const previous = boundedEpochs[index - 1]
    const current = boundedEpochs[index]
    if (previous.end_block === null || previous.end_block >= current.start_block!) {
      throw new Error(`overlapping epochs in ${deployment.deployment_id}`)
    }
  }
}

function assertProtocolRoles(deployment: DexProtocolDeployment): void {
  const requiredRoles =
    deployment.protocol === 'gmx'
      ? ['event_emitter', 'data_store', 'synthetics_reader']
      : ['diamond']
  const expectedUpgradeModel = deployment.protocol === 'gmx' ? 'modular_contracts' : 'diamond'
  if (deployment.upgrade_model !== expectedUpgradeModel) {
    throw new Error(`invalid upgrade model for ${deployment.deployment_id}`)
  }
  for (const epoch of deployment.epochs) {
    const roles = new Set(epoch.contracts.map((contract) => contract.role))
    for (const role of requiredRoles) {
      if (
        !roles.has(role as DexProtocolDeployment['epochs'][number]['contracts'][number]['role'])
      ) {
        throw new Error(`missing ${role} in ${deployment.deployment_id}:${epoch.version_id}`)
      }
    }
    if (epoch.contracts.filter((contract) => contract.event_source).length !== 1) {
      throw new Error(
        `deployment epoch must have exactly one event source: ${deployment.deployment_id}`
      )
    }
  }
}

function assertManifestInvariants(manifest: DexProtocolManifest): void {
  assertUnique(
    manifest.artifacts.map((artifact) => artifact.artifact_id),
    'artifact id'
  )
  assertUnique(
    manifest.deployments.map((deployment) => deployment.deployment_id),
    'deployment id'
  )

  const artifacts = new Map(
    manifest.artifacts.map((artifact) => [artifact.artifact_id, artifact] as const)
  )
  for (const artifact of manifest.artifacts) {
    if (artifact.license === 'BUSL-1.1' && artifact.usage !== 'reference_only') {
      throw new Error(`BUSL artifact must remain reference_only: ${artifact.artifact_id}`)
    }
  }

  for (const deployment of manifest.deployments) {
    const expectedId = `${deployment.protocol}:${deployment.chain.namespace}:${deployment.chain.chain_id}`
    if (deployment.deployment_id !== expectedId) {
      throw new Error(`deployment id does not match chain identity: ${deployment.deployment_id}`)
    }
    if (!Number.isSafeInteger(deployment.chain.chain_id)) {
      throw new Error(`unsafe chain id: ${deployment.chain.chain_id}`)
    }
    if (deployment.verification_state === 'draft' && deployment.blocking_reasons.length === 0) {
      throw new Error(`draft deployment requires blocking reasons: ${deployment.deployment_id}`)
    }
    if (deployment.verification_state === 'verified' && deployment.blocking_reasons.length > 0) {
      throw new Error(`verified deployment cannot retain blockers: ${deployment.deployment_id}`)
    }
    if (
      deployment.lifecycle_status === 'unverified' &&
      deployment.verification_state === 'verified'
    ) {
      throw new Error(`unverified lifecycle cannot be verified: ${deployment.deployment_id}`)
    }

    assertEpochs(deployment)
    assertProtocolRoles(deployment)
    for (const epoch of deployment.epochs) {
      for (const contract of epoch.contracts) {
        if (!artifacts.has(contract.address_artifact_id)) {
          throw new Error(`missing address artifact: ${contract.address_artifact_id}`)
        }
        if (contract.abi_artifact_id !== null && !artifacts.has(contract.abi_artifact_id)) {
          throw new Error(`missing ABI artifact: ${contract.abi_artifact_id}`)
        }
      }
    }
  }

  const hyperliquidExemptions = manifest.non_evm_exemptions.filter(
    (exemption) => exemption.protocol === 'hyperliquid'
  )
  if (hyperliquidExemptions.length !== 1) {
    throw new Error('manifest requires exactly one Hyperliquid non-EVM exemption')
  }
}

export function parseDexProtocolManifest(input: unknown): DexProtocolManifest {
  const manifest = manifestSchema.parse(input)
  assertManifestInvariants(manifest)
  return manifest
}

export function normalizeDexProtocolManifest(input: unknown): DexProtocolManifest {
  const manifest = parseDexProtocolManifest(input)
  return {
    ...manifest,
    artifacts: [...manifest.artifacts].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
    non_evm_exemptions: [...manifest.non_evm_exemptions].sort((a, b) =>
      a.protocol.localeCompare(b.protocol)
    ),
    deployments: manifest.deployments
      .map((deployment) => ({
        ...deployment,
        blocking_reasons: [...deployment.blocking_reasons].sort(),
        epochs: deployment.epochs
          .map((epoch) => ({
            ...epoch,
            contracts: [...epoch.contracts].sort((a, b) =>
              `${a.role}:${a.address.toLowerCase()}`.localeCompare(
                `${b.role}:${b.address.toLowerCase()}`
              )
            ),
          }))
          .sort((a, b) => a.version_id.localeCompare(b.version_id)),
        decoder: {
          ...deployment.decoder,
          required_fact_families: [...deployment.decoder.required_fact_families].sort(),
        },
        evidence: [...deployment.evidence].sort((a, b) =>
          `${a.official_url}:${a.claim}`.localeCompare(`${b.official_url}:${b.claim}`)
        ),
      }))
      .sort((a, b) => a.deployment_id.localeCompare(b.deployment_id)),
  }
}

export function dexProtocolManifestSha256(input: unknown): string {
  return canonicalSha256(normalizeDexProtocolManifest(input))
}

export function assertDexDeploymentShadowReady(input: unknown, deploymentId: string): void {
  const manifest = parseDexProtocolManifest(input)
  const deployment = manifest.deployments.find(
    (candidate) => candidate.deployment_id === deploymentId
  )
  if (!deployment) throw new Error(`unknown DEX deployment: ${deploymentId}`)
  if (deployment.lifecycle_status !== 'active') {
    throw new Error(`DEX deployment is not active: ${deploymentId}`)
  }
  if (deployment.verification_state !== 'verified') {
    throw new Error(`DEX deployment is not verified: ${deploymentId}`)
  }
  if (deployment.blocking_reasons.length > 0) {
    throw new Error(`DEX deployment still has blockers: ${deploymentId}`)
  }
  if (deployment.decoder.owner === null) {
    throw new Error(`DEX deployment has no decoder owner: ${deploymentId}`)
  }
  if (deployment.finality_policy === null) {
    throw new Error(`DEX deployment has no finality policy: ${deploymentId}`)
  }
  for (const epoch of deployment.epochs) {
    if (epoch.start_block === null) {
      throw new Error(`DEX deployment epoch has no start block: ${deploymentId}`)
    }
    for (const contract of epoch.contracts) {
      if (contract.abi_artifact_id === null) {
        throw new Error(
          `DEX deployment contract has no pinned ABI: ${deploymentId}:${contract.role}`
        )
      }
    }
  }
}
