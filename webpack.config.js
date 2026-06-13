const path = require('path');
const fs = require('fs');
const vm = require('vm');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

const ORIGIN_BRIDGE_ASSET_PATH = 'content/discover/origin-bridge.js';
const ORIGIN_BRIDGE_MARKER = '__BC_PLAYER_ORIGIN_BRIDGE_V3__';
const ORIGIN_BRIDGE_MESSAGE_SOURCE = 'bc-player-origin-bridge';
const ORIGIN_BRIDGE_COMMAND_SOURCE = 'bc-player-origin-bridge-command';

function extractTemplateExpression(source, pattern, label) {
  const match = source.match(pattern);

  if (!match || !match[1]) {
    throw new Error(`Failed to extract ${label} template expression`);
  }

  return match[1];
}

function renderTemplateExpression(templateExpression, scope = {}) {
  const argNames = Object.keys(scope);
  const argValues = Object.values(scope);
  const render = new Function(...argNames, `return ${templateExpression};`);

  return render(...argValues);
}

function buildOriginBridgeAssetSource() {
  const sectionADefinition = fs.readFileSync(
    path.resolve(__dirname, 'src/content/discover/origin-bridge/script/section-a.ts'),
    'utf8'
  );
  const sectionBDefinition = fs.readFileSync(
    path.resolve(__dirname, 'src/content/discover/origin-bridge/script/section-b.ts'),
    'utf8'
  );
  const sectionCDefinition = fs.readFileSync(
    path.resolve(__dirname, 'src/content/discover/origin-bridge/script/section-c.ts'),
    'utf8'
  );

  const sectionAExpression = extractTemplateExpression(
    sectionADefinition,
    /return\s+(`[\s\S]*?`)\s*;\s*}\s*$/,
    'origin bridge section A'
  );
  const sectionBExpression = extractTemplateExpression(
    sectionBDefinition,
    /=\s*(`[\s\S]*?`)\s*;\s*$/,
    'origin bridge section B'
  );
  const sectionCExpression = extractTemplateExpression(
    sectionCDefinition,
    /=\s*(`[\s\S]*?`)\s*;\s*$/,
    'origin bridge section C'
  );

  const sectionA = renderTemplateExpression(sectionAExpression, {
    marker: ORIGIN_BRIDGE_MARKER,
    source: ORIGIN_BRIDGE_MESSAGE_SOURCE,
    commandSource: ORIGIN_BRIDGE_COMMAND_SOURCE
  });
  const sectionB = renderTemplateExpression(sectionBExpression);
  const sectionC = renderTemplateExpression(sectionCExpression);

  const combined = [sectionA, sectionB, sectionC].join('\n');

  try {
    new vm.Script(combined, { filename: ORIGIN_BRIDGE_ASSET_PATH });
  } catch (error) {
    throw new Error(
      `Origin bridge syntax validation failed: ${error instanceof Error ? error.message : error}`
    );
  }

  return combined;
}

class GenerateOriginBridgeAssetPlugin {
  apply(compiler) {
    const pluginName = 'GenerateOriginBridgeAssetPlugin';

    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: pluginName,
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
        },
        () => {
          const source = buildOriginBridgeAssetSource();
          const { RawSource } = compiler.webpack.sources;

          compilation.emitAsset(ORIGIN_BRIDGE_ASSET_PATH, new RawSource(source));
        }
      );
    });
  }
}

module.exports = (env = {}, argv = {}) => {
  const target = (env.target || process.env.BROWSER || 'firefox').toLowerCase();
  const mode = (argv.mode || 'production').toLowerCase();
  const backgroundEntry =
    target === 'chrome'
      ? './src/targets/chrome/background/index.ts'
      : './src/targets/firefox/background/index.ts';
  const entries = {
    'background/index': backgroundEntry,
    'background/analysis-worker': './src/background/audio/analysis-worker.ts',
    'content/player/index': './src/content/player/index.ts',
    'content/discover/index': './src/content/discover/index.ts',
    'public/runtime-audio-host': './src/runtime-audio-host.ts',
    ...(target === 'chrome'
      ? { 'offscreen/analysis-host': './src/targets/chrome/offscreen/analysis-host.ts' }
      : {})
  };
  const manifestSource =
    target === 'chrome'
      ? 'src/manifest.json'
      : mode === 'development'
        ? 'src/manifest.firefox.dev.json'
        : 'src/manifest.firefox.json';
  const copyPatterns = [
    {
      from: 'src/assets/icons/*.svg',
      to: 'public/[name][ext]',
      noErrorOnMissing: true,
      globOptions: {
        ignore: ['**/.DS_Store']
      }
    },
    {
      from: 'src/assets/fonts/*',
      to: 'public/fonts/[name][ext]',
      noErrorOnMissing: true,
      globOptions: {
        ignore: ['**/.DS_Store']
      }
    },
    {
      from: 'src/assets/runtime-host/runtime-audio-host.html',
      to: 'public/runtime-audio-host.html'
    },
    {
      from: 'vendor/signalsmith/worklet.js',
      to: 'public/signalsmith/worklet.js'
    },
    { from: manifestSource, to: 'manifest.json' },
    {
      from: 'node_modules/essentia.js/dist/essentia-wasm.web.wasm',
      to: 'essentia-wasm.wasm'
    },
    {
      from: 'node_modules/essentia.js/dist/essentia-wasm.umd.js',
      to: 'essentia-wasm.umd.js'
    },
    {
      from: 'node_modules/signalsmith-stretch/SignalsmithStretch.mjs',
      to: 'public/signalsmith/SignalsmithStretch.mjs'
    },
    ...(target === 'chrome'
      ? [{
        from: 'src/targets/chrome/offscreen/analysis-host.html',
        to: 'offscreen/analysis-host.html'
      }]
      : [])
  ];

  return {
    mode: argv.mode || 'production',
    entry: entries,
    output: {
      path: path.resolve(__dirname, 'dist', target),
      filename: '[name].js',
      clean: true,
      globalObject: 'self'
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                noEmit: false
              }
            }
          },
          exclude: /node_modules/
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env']
            }
          }
        }
      ]
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      alias: {
        '@': path.resolve(__dirname, 'src'),
        'essentia.js/dist/essentia-wasm.umd.js': path.resolve(__dirname, 'src/background/audio/essentia-wasm-shim.ts')
      },
      fallback: {
        crypto: false,
        path: false,
        fs: false,
        stream: false,
        util: false,
        assert: false,
        buffer: require.resolve('buffer/'),
        process: require.resolve('process/browser')
      }
    },
    plugins: [
      new CleanWebpackPlugin(),
      new GenerateOriginBridgeAssetPlugin(),
      // Build-time browser target, so browser-specific behavior can be compiled per build
      // (Firefox and Chrome are separate products). Dead branches are dropped by the minifier.
      new webpack.DefinePlugin({
        __BUILD_TARGET__: JSON.stringify(target)
      }),
      new CopyWebpackPlugin({
        patterns: copyPatterns
      })
    ],
    devtool: 'source-map',
    target: 'web',
    performance: {
      hints: 'warning',
      maxAssetSize: 3 * 1024 * 1024,
      maxEntrypointSize: 3 * 1024 * 1024,
      assetFilter: (name) => !name.endsWith('.map')
    },
    experiments: {
      asyncWebAssembly: true
    }
  };
};
