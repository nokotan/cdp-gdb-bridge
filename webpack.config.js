const path = require('path');
const WasmPackPlugin = require("@wasm-tool/wasm-pack-plugin");

const generateConfig = (target) => {
  const fileNameWithoutExtension = path.basename(target, '.ts');
  const outputName = `${fileNameWithoutExtension}.js`;

  /**@type {import('webpack').Configuration}*/
  return {
    target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/

    entry: target, // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    // entry: './src/cli/index.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: {
      // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
      path: path.resolve(__dirname, 'packed'),
      filename: outputName,
      libraryTarget: 'commonjs2',
      devtoolModuleFilenameTemplate: '../[resource-path]'
    },
    name: fileNameWithoutExtension,
    devtool: 'source-map',
    externals: {
      vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    },
    resolve: {
      // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
      extensions: ['.ts', '.js', '.wasm']
    },
    plugins: [
      new WasmPackPlugin({
          crateDirectory: path.resolve(__dirname, "crates/dwarf")
      })
    ],
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'ts-loader'
            }
          ]
        }
      ]
    },
    experiments: {
      asyncWebAssembly: true,
      topLevelAwait: true
    }
  }
};
module.exports = [
  generateConfig('./src/vscode/extension.ts'),
  generateConfig('./src/vscode/dapServer.ts')
];