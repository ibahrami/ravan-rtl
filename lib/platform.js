const path = require('path');
const fs = require('fs');

function pathApiFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

function resolveAppPaths({ customPath, platform = process.platform, env = process.env }) {
    const pathApi = pathApiFor(platform);
    const isMac = platform === 'darwin';
    let appPath;
    let resourcesPath;
    let asarPath;
    let executablePath;

    if (customPath) {
        if (platform === 'linux' && fs.existsSync(customPath)) {
            customPath = fs.realpathSync(customPath);
            if (fs.statSync(customPath).isFile() && !customPath.endsWith('app.asar')) {
                executablePath = customPath;
                customPath = path.dirname(customPath);
            }
        }
        if (pathApi.basename(customPath).toLowerCase() === 'resources') customPath = pathApi.join(customPath, 'app.asar');
        if (pathApi.basename(customPath).toLowerCase() === 'app.asar') {
            asarPath = customPath;
            resourcesPath = pathApi.dirname(asarPath);
            appPath = isMac && pathApi.basename(pathApi.dirname(resourcesPath)) === 'Contents'
                ? pathApi.dirname(pathApi.dirname(resourcesPath))
                : pathApi.dirname(resourcesPath);
        } else {
            appPath = customPath;
            resourcesPath = isMac
                ? pathApi.join(appPath, 'Contents', 'Resources')
                : pathApi.join(appPath, 'resources');
            asarPath = pathApi.join(resourcesPath, 'app.asar');
        }
    } else if (isMac) {
        appPath = '/Applications/Claude.app';
        resourcesPath = pathApi.join(appPath, 'Contents', 'Resources');
        asarPath = pathApi.join(resourcesPath, 'app.asar');
    } else if (platform === 'win32') {
        appPath = pathApi.join(env.LOCALAPPDATA || env.APPDATA || '', 'Programs', 'Claude');
        resourcesPath = pathApi.join(appPath, 'resources');
        asarPath = pathApi.join(resourcesPath, 'app.asar');
    } else if (platform === 'linux') {
        const installation = discoverLinuxInstall(env);
        return { ...resolveAppPaths({ customPath: installation.executablePath, platform, env }), ...installation };
    } else {
        throw new Error('Auto-detection failed. Please provide the path to your Claude installation manually.');
    }

    return {
        appPath,
        executablePath,
        resourcesPath,
        asarPath,
        backupPath: pathApi.join(resourcesPath, 'app.asar.bak'),
        infoPlistPath: isMac ? pathApi.join(appPath, 'Contents', 'Info.plist') : null
    };
}

function discoverLinuxInstall(env) {
    const dataDirs = [env.XDG_DATA_HOME || path.join(env.HOME || '', '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
    const launcherPath = dataDirs.map(dir => path.join(dir, 'applications/com.anthropic.Claude.desktop')).find(file => fs.existsSync(file));
    const command = launcherPath ? fs.readFileSync(launcherPath, 'utf8').match(/^Exec=(?:"([^"]+)"|([^\s]+))/m) : null;
    const name = command ? command[1] || command[2] : 'claude-desktop';
    const executable = path.isAbsolute(name) ? name : (env.PATH || '').split(':').filter(Boolean).map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
    if (!executable || !fs.existsSync(executable)) throw new Error('Cannot resolve the Claude desktop launcher. Use --path /path/to/resources/app.asar.');
    const executablePath = fs.realpathSync(executable);
    if (!fs.existsSync(path.join(path.dirname(executablePath), 'resources/app.asar'))) {
        throw new Error(`Launcher ${launcherPath || name} resolves to a wrapper, Flatpak, or AppImage without a writable ASAR. Diagnose its mounted/resources path explicitly with --path; signed/read-only containers are not patched in place.`);
    }
    return { launcherPath: launcherPath || null, executablePath };
}

function isWindowsAppsPath(filePath) {
    return /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(filePath);
}

module.exports = { resolveAppPaths, isWindowsAppsPath };
