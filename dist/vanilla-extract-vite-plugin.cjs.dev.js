'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var compiler = require('@vanilla-extract/compiler');
var integration = require('@vanilla-extract/integration');
var path = require('path');

// Vite wraps module ids that aren't valid browser import specifiers with
// `/@id/` in dev mode. The leading slash is sometimes already stripped.
const viteIdPrefix = /^\/?@id\//;
// Vite emits posix separators and sometimes prefixes a Windows drive letter
// with a slash, e.g. a resolved id like `/C:/...`.
const slashPrefixedDrive = /^\/([a-zA-Z]:\/)/;
// A Windows drive path (`C:/...`) is unambiguously a real absolute path
// unlike a posix `/...` path, which may be an SSR root-relative id.
const windowsAbsolutePathRegex = /^[a-zA-Z]:\//;
const isWindowsAbsolutePath = filePath => windowsAbsolutePathRegex.test(filePath);
const isAbsolutePath = filePath => path.posix.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);

// Strip Vite's `@id/` wrapper and any slash it prefixes onto a Windows drive.
const unwrapViteId = id => {
  const unwrapped = id.replace(viteIdPrefix, '').replace(slashPrefixedDrive, '$1');

  // If unwrapping didn't yield an absolute path, the `@id/` prefix wasn't a
  // path wrapper, so keep the original id.
  return isAbsolutePath(unwrapped) ? unwrapped : id;
};
const getAbsoluteId = ({
  filePath,
  root
}) => {
  const resolvedId = unwrapViteId(filePath);
  if (
  // A Windows drive path is always a real absolute path.
  isWindowsAbsolutePath(resolvedId) || resolvedId.startsWith(root) ||
  // In monorepos the absolute path is outside of `root`, so we check they
  // share a filesystem root. Vite paths always use posix separators.
  path.posix.isAbsolute(resolvedId) && resolvedId.split(path.posix.sep)[1] === root.split(path.posix.sep)[1]) {
    return integration.normalizePath(resolvedId);
  }

  // In SSR mode we can have root-relative paths like `/app/styles.css.ts`.
  return integration.normalizePath(path.posix.join(root, resolvedId));
};

const PLUGIN_NAMESPACE = 'vite-plugin-vanilla-extract';
const virtualExtCss = '.vanilla.css';
const isVirtualId = id => id.endsWith(virtualExtCss);
const fileIdToVirtualId = id => `${id}${virtualExtCss}`;
const virtualIdToFileId = virtualId => virtualId.slice(0, -virtualExtCss.length);
const isPluginObject = plugin => typeof plugin === 'object' && plugin !== null && 'name' in plugin;
// Plugins that we know are compatible with the `vite-node` compiler
// and don't need to be filtered out.
const COMPATIBLE_PLUGINS = ['vite-tsconfig-paths'];
const defaultPluginFilter = ({
  name
}) => COMPATIBLE_PLUGINS.includes(name);
const withUserPluginFilter = ({
  mode,
  pluginFilter
}) => plugin => pluginFilter({
  name: plugin.name,
  mode
});
function vanillaExtractPlugin({
  identifiers,
  unstable_pluginFilter: pluginFilter = defaultPluginFilter,
  unstable_mode = 'emitCss',
  cssFileFilter: fileFilter = integration.cssFileFilter
} = {}) {
  let config;
  let configEnv;
  let server;
  let packageName;
  let compiler$1;
  let compilerReady;
  let isBuild;
  const vitePromise = import('vite');
  const transformedModules = new Set();
  const getIdentOption = () => identifiers ?? (config.mode === 'production' ? 'short' : 'debug');

  /**
   * Custom invalidation function that takes a chain of importers to invalidate. If an importer is a
   * VE module, its virtual CSS is invalidated instead. Otherwise, the module is invalidated
   * normally.
   */
  const invalidateImporterChain = ({
    importerChain,
    server,
    timestamp
  }) => {
    const {
      moduleGraph
    } = server;
    const seen = new Set();
    for (const mod of importerChain) {
      if (mod.id && fileFilter.test(mod.id)) {
        const virtualModules = moduleGraph.getModulesByFile(fileIdToVirtualId(mod.id));
        for (const virtualModule of virtualModules ?? []) {
          moduleGraph.invalidateModule(virtualModule, seen, timestamp, true);
        }
      } else if (mod.id) {
        // `mod` is from the compiler's internal Vite server, so look up the
        // corresponding module in the consuming server's graph by ID
        const serverMod = moduleGraph.getModuleById(mod.id);
        if (serverMod) {
          moduleGraph.invalidateModule(serverMod, seen, timestamp, true);
        }
      }
    }
  };
  const initializeCompiler = async () => {
    var _configForViteCompile;
    const {
      loadConfigFromFile
    } = await vitePromise;
    let configForViteCompiler;

    // The user has a vite config file
    if (config.configFile) {
      const configFile = await loadConfigFromFile({
        command: config.command,
        mode: config.mode,
        isSsrBuild: configEnv.isSsrBuild
      }, config.configFile);
      configForViteCompiler = configFile === null || configFile === void 0 ? void 0 : configFile.config;
    }
    // The user is using a vite-based framework that has a custom config file
    else {
      configForViteCompiler = config.inlineConfig;
    }
    const viteConfig = {
      ...configForViteCompiler,
      plugins: (_configForViteCompile = configForViteCompiler) === null || _configForViteCompile === void 0 || (_configForViteCompile = _configForViteCompile.plugins) === null || _configForViteCompile === void 0 ? void 0 : _configForViteCompile.flat().filter(isPluginObject).filter(withUserPluginFilter({
        mode: config.mode,
        pluginFilter
      }))
    };
    compiler$1 = compiler.createCompiler({
      root: config.root,
      identifiers: getIdentOption(),
      cssImportSpecifier: fileIdToVirtualId,
      cssFileFilter: fileFilter,
      viteConfig,
      enableFileWatcher: !isBuild
    });
  };

  /**
   * Lazily creates the compiler, memoizing the initialization promise.
   *
   * `buildStart` kicks this off eagerly, but `transform` also awaits it. This
   * matters because `transform` can run before `buildStart` has finished
   * creating the compiler when another plugin emits an additional entry whose
   * module graph is transformed concurrently (e.g. a module federation plugin
   * exposing a module as its own chunk). Without awaiting, `transform` would
   * bail and leave the `.css.ts` untransformed, producing runtime `style()`
   * calls that throw "Styles were unable to be assigned to a file".
   */
  const ensureCompiler = () => {
    if (unstable_mode === 'transform') {
      return Promise.resolve();
    }
    compilerReady ?? (compilerReady = initializeCompiler());
    return compilerReady;
  };
  return [{
    name: `${PLUGIN_NAMESPACE}-inline-dev-css`,
    apply: (_, {
      command
    }) => command === 'serve' && unstable_mode === 'inlineCssInDev',
    transformIndexHtml: async () => {
      var _compiler;
      const allCss = (_compiler = compiler$1) === null || _compiler === void 0 ? void 0 : _compiler.getAllCss();
      if (!allCss) {
        return [];
      }
      return [{
        tag: 'style',
        children: allCss,
        attrs: {
          type: 'text/css',
          'data-vanilla-extract-inline-dev-css': true
        },
        injectTo: 'head-prepend'
      }];
    }
  }, {
    name: PLUGIN_NAMESPACE,
    configureServer(_server) {
      server = _server;
      server.watcher.on('unlink', file => {
        transformedModules.delete(integration.normalizePath(file));
      });
    },
    config(_userConfig, _configEnv) {
      configEnv = _configEnv;
      return {
        ssr: {
          external: ['@vanilla-extract/css', '@vanilla-extract/css/fileScope', '@vanilla-extract/css/adapter']
        }
      };
    },
    configResolved(_resolvedConfig) {
      config = _resolvedConfig;
      isBuild = config.command === 'build' && !config.build.watch;
      packageName = integration.getPackageInfo(config.root).name;
    },
    async buildStart() {
      // Ensure we re-use the compiler instance between builds, e.g. in watch mode
      await ensureCompiler();
    },
    buildEnd() {
      // When using the rollup watcher, we don't want to close the compiler after every build.
      // Instead, we close it when the watcher is closed via the closeWatcher hook.
      if (!config.build.watch) {
        var _compiler2;
        (_compiler2 = compiler$1) === null || _compiler2 === void 0 || _compiler2.close();
      }
    },
    closeWatcher() {
      var _compiler3;
      return (_compiler3 = compiler$1) === null || _compiler3 === void 0 ? void 0 : _compiler3.close();
    },
    async transform(code, id, options) {
      const [validId] = id.split('?');
      if (!fileFilter.test(validId)) {
        return null;
      }
      const identOption = getIdentOption();
      const normalizedId = integration.normalizePath(validId);
      if (unstable_mode === 'transform') {
        transformedModules.add(normalizedId);
        return integration.transform({
          source: code,
          filePath: normalizedId,
          rootPath: config.root,
          packageName,
          identOption
        });
      }

      // `transform` can run before `buildStart` has finished creating the
      // compiler (e.g. when another plugin emits an additional entry whose
      // module graph is transformed concurrently). Await the memoized
      // initialization rather than bailing, which would leave this `.css.ts`
      // untransformed. `ensureCompiler` is memoized, so this is a no-op once
      // the compiler exists.
      await ensureCompiler();
      if (!compiler$1) {
        return null;
      }
      const absoluteId = getAbsoluteId({
        filePath: validId,
        root: config.root
      });
      const {
        source,
        watchFiles
      } = await compiler$1.processVanillaFile(absoluteId, {
        outputCss: true
      });
      transformedModules.add(normalizedId);
      const result = {
        code: source,
        map: {
          mappings: ''
        }
      };

      // We don't need to watch files or invalidate modules in build mode or during SSR
      if (isBuild || options !== null && options !== void 0 && options.ssr) {
        return result;
      }
      for (const file of watchFiles) {
        if (!file.includes('node_modules') && integration.normalizePath(file) !== absoluteId) {
          this.addWatchFile(file);
        }
      }
      return result;
    },
    // The compiler's module graph is always a subset of the consuming Vite dev server's module
    // graph, so this early exit will be hit for any modules that aren't related to VE modules.
    async handleHotUpdate({
      file,
      server,
      timestamp
    }) {
      if (!compiler$1) {
        return;
      }
      const importerChain = await compiler$1.findImporterTree(integration.normalizePath(file), transformedModules);
      if (importerChain.size === 0) {
        return;
      }
      invalidateImporterChain({
        importerChain,
        server,
        timestamp
      });
    },
    resolveId(source) {
      const [validId, query] = source.split('?');
      if (!isVirtualId(validId)) return;
      const absoluteId = getAbsoluteId({
        filePath: validId,
        root: config.root
      });
      if (!compiler$1) return;

      // The only valid scenario for a missing CSS entry is if someone had
      // written a file in their app using the .vanilla.js/.vanilla.css
      // extension, or the file produced no CSS output.
      const {
        css
      } = compiler$1.getCssForFile(virtualIdToFileId(absoluteId));
      if (css) {
        // Keep the original query string for HMR.
        return absoluteId + (query ? `?${query}` : '');
      }
    },
    load(id) {
      const [validId] = id.split('?');
      if (!isVirtualId(validId) || !compiler$1) return;
      const absoluteId = getAbsoluteId({
        filePath: validId,
        root: config.root
      });
      const {
        css
      } = compiler$1.getCssForFile(virtualIdToFileId(absoluteId));
      if (css) {
        return css;
      }
    }
  }];
}

exports.vanillaExtractPlugin = vanillaExtractPlugin;
