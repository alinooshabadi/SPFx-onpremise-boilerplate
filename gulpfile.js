'use strict';

if (process.argv.indexOf('deploy') !== -1) {
  process.argv.push('--ship');
}

const gulp = require('gulp');
const path = require('path');
const spSave = require('gulp-spsave');
const runSequence = require('run-sequence');
const publishInfo = require('./credentials.js');
const build = require('@microsoft/sp-build-web');
const spPackageDeploy = require('node-sppkg-deploy');
const bundleAnalyzer = require('webpack-bundle-analyzer');
const packageFilePath = './config/package-solution.json';
const util = require("util");
const log = require('fancy-log');
const fs = require('fs-extra');

let originalPackageSolutionContent;
let originalWebPartManifests = [];


gulp.task('deploy', function () {
  runSequence('change-environment', 'clean', 'bundle', 'package-solution', 'upload-package', 'deploy-package')
});
//'reset-package-solution'


build.task('change-environment', {
  execute: (config) => {
    return new Promise((resolve) => {
      const stripJSONComments = (data) => {
        var re = new RegExp("\/\/ (.*)", "g");
        return data.replace(re, '');
      }

      let envConfigFile = JSON.parse(fs.readFileSync('./config/env-config.json'));

      const environment = config.args["env"];
      log.info('Configured environment: ' + environment);

      const envConfigJSON = envConfigFile.environments.filter(env => env.environment === environment)[0];
      if (!envConfigJSON) {
        log.error('\x1b[31m%s\x1b[0m', `No configuration for environment '${environment}' has been defined`);
      } else {
        // change package-solution
        originalPackageSolutionContent = fs.readFileSync(packageFilePath, 'utf8');

        let packageFileJSON = JSON.parse(fs.readFileSync(packageFilePath));

        packageFileJSON.solution.id = envConfigJSON.id;
        packageFileJSON.solution.name = envConfigJSON.name;
        packageFileJSON.paths.zippedPackage = envConfigJSON.zip;
        fs.writeFileSync(packageFilePath, JSON.stringify(packageFileJSON));

        envConfigJSON.entries.forEach((config) => {

          // change manifest
          if (!fs.existsSync(config.location)) {
            log('\x1b[31m%s\x1b[0m', "File not found");
          }

          let fileContent = fs.readFileSync(config.location, 'utf8');

          originalWebPartManifests.push({
            key: config.location,
            content: fileContent
          });

          let strippedEntryFile = stripJSONComments(fileContent);
          let entryJSON = JSON.parse(strippedEntryFile);

          entryJSON.id = config.id;
          if (entryJSON.componentType === 'WebPart') {
            entryJSON.preconfiguredEntries[0].title.default = config.name;
            entryJSON.alias = config.name;
          } else {
            entryJSON.alias = config.name;
          }
          fs.writeFileSync(config.location, JSON.stringify(entryJSON));
        });
      }
      resolve();

    })
  }
});

gulp.task('upload-package', function () {
  const packageFile = require(packageFilePath);
  const folderLocation = `./sharepoint/${packageFile.paths.zippedPackage}`;
  console.log(folderLocation);
  return gulp.src(folderLocation).pipe(
    spSave({
        siteUrl: publishInfo.catalogSite,
        folder: 'AppCatalog'
      },
      publishInfo
    )
  );
});

build.task('deploy-package', {
  execute: (config) => {
    const packageFile = require(packageFilePath);
    let filename = packageFile.paths.zippedPackage;
    filename = filename.split('/').pop();
    const skipFeatureDeployment = packageFile.solution.skipFeatureDeployment ?
      packageFile.solution.skipFeatureDeployment :
      false;
    return spPackageDeploy.deploy({
      username: publishInfo.username,
      password: publishInfo.password,
      absoluteUrl: publishInfo.catalogSite,
      filename: filename,
      skipFeatureDeployment: skipFeatureDeployment,
      verbose: config.args['verbose'] ? true : false
    });
  }
});

build.task('update-version', {
  execute: (config) => {
    return new Promise((resolve, reject) => {
      let json = JSON.parse(fs.readFileSync(packageFilePath));
      if (config.args['major']) {
        var majorVersion = parseInt(json.solution.version.split('.')[0]);
        majorVersion++;
        json.solution.version = majorVersion + '.0.0.0';
      } else if (config.args['minor']) {
        var minorVersion = parseInt(json.solution.version.split('.')[1]);
        minorVersion++;
        json.solution.version = json.solution.version.split('.')[0] + '.' + minorVersion + '.0.0';
      }
      fs.writeFileSync(packageFilePath, JSON.stringify(json));
      resolve();
    });
  }
});

build.task('reset-package-solution', {
  execute: (config) => {
    return new Promise((resolve) => {
      let envConfigFile = JSON.parse(fs.readFileSync('./config/env-config.json'));

      const environment = config.args["env"];
      log.info('Configured environment: ' + environment);

      const envConfigJSON = envConfigFile.environments.filter(env => env.environment === environment)[0];
      if (!envConfigJSON) {
        log.error('\x1b[31m%s\x1b[0m', `No configuration for environment '${environment}' has been defined`);
      } else {
        fs.writeFileSync(packageFilePath, originalPackageSolutionContent);

        originalWebPartManifests.forEach((config) => {
          fs.writeFileSync(config.key, config.content);
        });
      }
      resolve();
    });
  }
});



build.configureWebpack.mergeConfig({
  additionalConfiguration: (generatedConfiguration) => {
    // add bundle analyzer to pipeline
    const lastDirName = path.basename(__dirname);
    const dropPath = path.join(__dirname, 'temp', 'stats');
    generatedConfiguration.plugins.push(
      new bundleAnalyzer.BundleAnalyzerPlugin({
        openAnalyzer: false,
        analyzerMode: 'static',
        reportFilename: path.join(dropPath, `${lastDirName}.stats.html`),
        generateStatsFile: false,
        statsFilename: path.join(dropPath, `${lastDirName}.stats.json`),
        logLevel: 'error'
      })
    );

    // fix react, react-dom issue in production
    generatedConfiguration.externals = generatedConfiguration.externals.filter(
      (name) => !['react', 'react-dom'].includes(name)
    );

    return generatedConfiguration;
  }
});

build.tslint.setConfig({
  lintConfig: require('./tslint.json'),
  sourceMatch: ['src/*/.ts', 'src/*/.tsx', '!src/*/.scss.tsx']
});

build.initialize(gulp);
