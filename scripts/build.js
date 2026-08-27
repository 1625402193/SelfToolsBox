const { build, Platform } = require('electron-builder')
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const args = process.argv.slice(2)
const edition = args[0] || 'all' // 'full', 'work', 'all'

const projectDir = path.resolve(__dirname, '..')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function cleanDir(dir) {
  const fullPath = path.resolve(projectDir, dir)
  for (let i = 0; i < 5; i++) {
    if (!fs.existsSync(fullPath)) return true
    try {
      fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 2000 })
      return true
    } catch (e) {
      console.log(`  Retry ${i + 1}/5: waiting for files to be released...`)
      const { execSync } = require('child_process')
      execSync('ping -n 4 127.0.0.1 > nul', { stdio: 'ignore', shell: true })
    }
  }
  console.log(`  Warning: Could not fully clean ${dir}, continuing anyway...`)
  return false
}

async function buildEdition(editionName, retryCount = 0) {
  const MAX_RETRIES = 3
  console.log(`\n========== Building ${editionName} edition ${retryCount > 0 ? `(retry ${retryCount})` : ''} ==========\n`)

  // Set environment variable and run vite build
  process.env.VITE_EDITION = editionName
  console.log(`VITE_EDITION=${editionName}`)
  console.log('Running vite build...')
  execSync('npx vite build', { cwd: projectDir, stdio: 'inherit', env: { ...process.env, VITE_EDITION: editionName } })

  const outputDir = path.resolve('D:/Tool/tools_release', editionName)
  console.log(`Cleaning output directory: ${outputDir}`)
  if (fs.existsSync(outputDir)) {
    try { fs.rmSync(outputDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 2000 }) } catch (e) { console.log('  Warning: clean failed, continuing...') }
  }
  
  // Wait for Windows Defender to finish any lingering scans
  console.log('Waiting for system to release file locks...')
  await sleep(5000)

  const artifactName = editionName === 'work'
    ? '多功能工具箱-工作版 ${version}.${ext}'
    : editionName === 'normal'
      ? '多功能工具箱-普通版 ${version}.${ext}'
      : '多功能工具箱-全能版 ${version}.${ext}'

  const appIdMap = {
    work: 'com.tools.file-classifier-work',
    normal: 'com.tools.file-classifier-normal',
    full: 'com.tools.file-classifier',
  }
  const productNameMap = {
    work: 'ToolBox-Work',
    normal: 'ToolBox-Normal',
    full: 'ToolBox',
  }

  const config = {
    extends: null,
    appId: appIdMap[editionName] || appIdMap.full,
    productName: productNameMap[editionName] || productNameMap.full,
    directories: { output: outputDir },
    files: ['dist/**/*', 'electron/**/*', '!node_modules'],
    extraResources: [{ from: 'electron/data', to: 'data' }],
    win: {
      target: [{ target: 'portable', arch: ['x64'] }],
      icon: 'public/icon.png',
      signAndEditExecutable: false,
    },
    portable: { artifactName },
  }

  try {
    await build({ config, targets: Platform.WINDOWS.createTarget('portable') })
    console.log(`\n✅ ${editionName} edition build SUCCESS!\n`)
    return true
  } catch (err) {
    if (retryCount < MAX_RETRIES && (err.message.includes('EBUSY') || err.message.includes('UNKNOWN') || err.message.includes('Unable to commit') || err.message.includes('ERR_ELECTRON_BUILDER_CANNOT_EXECUTE'))) {
      console.log(`\n⚠️  Build failed due to file lock, retrying in 10 seconds... (${retryCount + 1}/${MAX_RETRIES})`)
      await sleep(10000)
      return buildEdition(editionName, retryCount + 1)
    }
    throw err
  }
}

async function main() {
  try {
    if (edition === 'all') {
      await buildEdition('full')
      await buildEdition('work')
      await buildEdition('normal')
    } else {
      await buildEdition(edition)
    }
    console.log('\n🎉 All builds completed successfully!')
    console.log('Output files:')
    const releaseDir = path.resolve('D:/Tool/tools_release')
    if (fs.existsSync(releaseDir)) {
      const editions = fs.readdirSync(releaseDir)
      for (const ed of editions) {
        const edDir = path.resolve(releaseDir, ed)
        if (fs.statSync(edDir).isDirectory()) {
          const files = fs.readdirSync(edDir).filter(f => f.endsWith('.exe'))
          for (const f of files) {
            const fPath = path.resolve(edDir, f)
            if (!fPath.includes('win-unpacked')) {
              const stat = fs.statSync(fPath)
              console.log(`  📦 D:/Tool/tools_release/${ed}/${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Build failed:', err.message)
    process.exit(1)
  }
}

main()
