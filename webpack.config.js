const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  
  return {
    mode: argv.mode || 'development',
    devtool: isDev ? 'inline-source-map' : 'source-map',
    
    entry: {
      'background/index': './src/background/index.ts',
      'content-scripts/bandcamp-player': './src/content-scripts/bandcamp-player.ts',
      'ui/results-panel': './src/ui/results-panel.ts'
    },
    
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/
        }
      ]
    },
    
    resolve: {
      extensions: ['.ts', '.js'],
      alias: {
        '@background': path.resolve(__dirname, 'src/background'),
        '@ui': path.resolve(__dirname, 'src/ui'),
        '@content': path.resolve(__dirname, 'src/content-scripts'),
        '@types': path.resolve(__dirname, 'src/types')
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
          { from: 'manifest.json', to: 'manifest.json' },
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
