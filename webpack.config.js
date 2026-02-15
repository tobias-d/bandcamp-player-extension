const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  
  return {
    mode: argv.mode || 'development',
    devtool: isDev ? 'inline-source-map' : 'source-map',
    
    entry: {
      'background/index': './src/background/index.ts',
      'content-scripts/bandcamp-player': './src/content-scripts/bandcamp-player.js',
      'ui/results-panel': './src/ui/results-panel.js'
    },
    
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          type: 'javascript/esm'  // ← Tell webpack to treat .js as ES modules
        }
      ]
    },
    
    resolve: {
      extensions: ['.ts', '.js'],
      extensionAlias: {
        '.js': ['.js', '.ts']
      },
      alias: {
        '@background': path.resolve(__dirname, 'src/background'),
        '@ui': path.resolve(__dirname, 'src/ui'),
        '@content': path.resolve(__dirname, 'src/content-scripts'),
        '@shared': path.resolve(__dirname, 'src/shared')
      }
    },
    
    output: {
      filename: '[name].js',
      path: path.resolve(__dirname, 'dist'),
      clean: true
    },
    
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'src/manifest.json', to: 'manifest.json' },
          { from: 'src/ui/*.html', to: 'ui/[name][ext]', noErrorOnMissing: true },
          { from: 'src/ui/*.css', to: 'ui/[name][ext]', noErrorOnMissing: true },
          { from: 'icons', to: 'icons', noErrorOnMissing: true }
        ]
      })
    ],
    
    optimization: {
      minimize: !isDev
    }
  };
};
