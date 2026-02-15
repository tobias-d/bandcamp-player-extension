const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  devtool: 'source-map',
  
  entry: {
    'content-scripts/bandcamp-player': './src/content-scripts/bandcamp-player.ts',
    'ui/results-panel': './src/ui/results-panel.js',
    background: './src/background/index.ts', // ← Changed from .js to .ts
  },
  
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
  },
  
  resolve: {
    extensions: ['.ts', '.js'],
  },
  
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: { 
          loader: 'babel-loader', 
          options: { presets: ['@babel/preset-env'] } 
        },
      },
    ],
  },
  
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' }
      ],
    }),
  ],
};
