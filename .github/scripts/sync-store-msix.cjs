const fs = require('fs')
const { execFileSync } = require('child_process')

const mode = process.argv[2]
const tag = process.env.RELEASE_TAG
const repo = process.env.GITHUB_REPOSITORY
const outputPath = process.env.GITHUB_OUTPUT
const tmpDir = process.env.RUNNER_TEMP || process.cwd()
const finalAttempt = process.env.FINAL_ATTEMPT === 'true'

if (!mode || !tag || !repo) {
  throw new Error('Usage: sync-store-msix.cjs <check|finalize>; RELEASE_TAG and GITHUB_REPOSITORY are required.')
}

function appendOutput(name, value) {
  if (!outputPath) return
  fs.appendFileSync(outputPath, `${name}=${value}\n`)
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function getRelease() {
  return JSON.parse(gh(['release', 'view', tag, '--json', 'assets,body,databaseId,isDraft']))
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function releaseDownloadUrl(assetName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

function latestDownloadUrl(assetName) {
  return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(assetName)}`
}

function findPackageAsset(assets) {
  return (
    assets.find((asset) => /x64.*\.(msixbundle|appxbundle|msix|appx)$/i.test(asset.name)) ||
    assets.find((asset) => /\.(msixbundle|appxbundle|msix|appx)$/i.test(asset.name))
  )
}

function hasAsset(assets, name) {
  return assets.some((asset) => asset.name === name)
}

function check() {
  const release = getRelease()
  const assets = Array.isArray(release.assets) ? release.assets : []
  const complete = release.isDraft !== true || hasAsset(assets, 'BlockInsight.appinstaller')

  if (complete) {
    console.log(`Store MSIX sync is already complete for ${tag}.`)
    appendOutput('should_sync', 'false')
    appendOutput('synced', 'true')
    return
  }

  appendOutput('should_sync', 'true')
  appendOutput('synced', 'false')
}

function buildAppInstaller(packageAsset, packageVersion) {
  const identityName = process.env.IDENTITY_NAME
  const publisher = process.env.PUBLISHER
  if (!identityName || !publisher) {
    throw new Error(
      'WINDOWS_PACKAGE_IDENTITY_NAME and WINDOWS_PACKAGE_PUBLISHER are required.'
    )
  }

  const packageKind = /\.(msixbundle|appxbundle)$/i.test(packageAsset.name)
    ? 'MainBundle'
    : 'MainPackage'
  const architecture = packageKind === 'MainPackage' ? ' ProcessorArchitecture="x64"' : ''

  return `<?xml version="1.0" encoding="utf-8"?>
<AppInstaller
  xmlns="http://schemas.microsoft.com/appx/appinstaller/2021"
  Version="${xmlEscape(packageVersion)}"
  Uri="${xmlEscape(latestDownloadUrl('BlockInsight.appinstaller'))}">

  <${packageKind}
    Name="${xmlEscape(identityName)}"
    Publisher="${xmlEscape(publisher)}"
    Version="${xmlEscape(packageVersion)}"${architecture}
    Uri="${xmlEscape(releaseDownloadUrl(packageAsset.name))}" />

  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="12" />
    <AutomaticBackgroundTask />
  </UpdateSettings>
</AppInstaller>
`
}

function buildReleaseNotes(release) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const macArm64Asset =
    assets.find((asset) => /arm64.*\.dmg$/i.test(asset.name)) ||
    assets.find((asset) => /\.dmg$/i.test(asset.name))
  const macX64Asset = assets.find((asset) => /x64.*\.dmg$/i.test(asset.name))
  const lines = ['## 下载', '']

  lines.push(`Windows：[x64](${latestDownloadUrl('BlockInsight.appinstaller')})`)

  const arm64Text = macArm64Asset
    ? `[M 芯片](${releaseDownloadUrl(macArm64Asset.name)})`
    : 'M 芯片安装包上传后会在这里显示下载链接'
  const x64Text = macX64Asset
    ? `[intel 芯片](${releaseDownloadUrl(macX64Asset.name)})`
    : 'intel 芯片安装包上传后会在这里显示下载链接'
  lines.push(`macOS：${arm64Text}｜ ${x64Text}`)

  const existingBody = typeof release.body === 'string' ? release.body.trim() : ''
  const changelogIndex = existingBody.indexOf('## 更新日志')
  if (changelogIndex >= 0) {
    lines.push('', existingBody.slice(changelogIndex).trim())
  } else if (existingBody && !existingBody.startsWith('## 下载')) {
    lines.push('', '## 更新日志', '', existingBody)
  }

  return lines.join('\n')
}

function uploadTimeoutMarker() {
  const markerPath = `${tmpDir}/store-msix-sync-timeout.txt`
  fs.writeFileSync(
    markerPath,
    [
      'Store-signed MSIX was not available after the final sync attempt.',
      `Release tag: ${tag}`,
      `Checked at: ${new Date().toISOString()}`
    ].join('\n')
  )
  gh(['release', 'upload', tag, markerPath, '--clobber'])
}

function finalize() {
  const release = getRelease()
  const assets = Array.isArray(release.assets) ? release.assets : []
  const packageAsset = findPackageAsset(assets)

  if (!packageAsset) {
    if (finalAttempt) {
      uploadTimeoutMarker()
      throw new Error(`Store-signed MSIX was not available after the final sync attempt for ${tag}.`)
    }

    console.log(`Store-signed MSIX is not available yet for ${tag}.`)
    appendOutput('synced', 'false')
    return
  }

  const versionMatch = packageAsset.name.match(/(\d+\.\d+\.\d+\.\d+)/)
  if (!versionMatch) {
    throw new Error(`Cannot infer Windows package version from ${packageAsset.name}.`)
  }

  const appInstallerPath = `${tmpDir}/BlockInsight.appinstaller`
  const notesPath = `${tmpDir}/release-notes.md`
  fs.writeFileSync(appInstallerPath, buildAppInstaller(packageAsset, versionMatch[1]))
  fs.writeFileSync(notesPath, buildReleaseNotes(release))

  try {
    gh(['release', 'delete-asset', tag, 'BlockInsight.appinstaller', '--yes'])
  } catch {
    // Asset may not exist on the first successful sync.
  }

  try {
    gh(['release', 'delete-asset', tag, 'store-msix-sync-timeout.txt', '--yes'])
  } catch {
    // Timeout marker only exists after a previous final failure.
  }

  gh(['release', 'upload', tag, appInstallerPath, '--clobber'])
  gh(['release', 'edit', tag, '--notes-file', notesPath])
  gh(['api', '-X', 'PATCH', `/repos/${repo}/releases/${release.databaseId}`, '-F', 'draft=false'])
  appendOutput('synced', 'true')
}

if (mode === 'check') {
  check()
} else if (mode === 'finalize') {
  finalize()
} else {
  throw new Error(`Unknown mode: ${mode}`)
}
