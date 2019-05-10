const path = require('path');
const { readFileSync, readFile, stat, lstat, readlink, statSync } = require('graceful-fs');
const { walk } = require('estree-walker');
const MagicString = require('magic-string');
const { attachScopes } = require('rollup-pluginutils');
const evaluate = require('./utils/static-eval');
let acorn = require('acorn');
const bindings = require('bindings');
const getUniqueAssetName = require('./utils/dedupe-names');
const sharedlibEmit = require('./utils/sharedlib-emit');
const glob = require('glob');
const getPackageBase = require('./utils/get-package-base');
const getPackageScope = require('./utils/get-package-scope');
const { pregyp, nbind } = require('./utils/binary-locators');
const handleWrappers = require('./utils/wrappers');
const handleSpecialCase = require('./utils/special-cases');
const { getOptions } = require("loader-utils");
const resolve = require('resolve');
const stage3 = require('acorn-stage3');
const mergeSourceMaps = require('./utils/merge-source-maps');
acorn = acorn.Parser.extend(stage3);
const os = require('os');

const extensions = ['.js', '.json', '.node'];

const staticPath = Object.assign({ default: path }, path);
const { UNKNOWN, FUNCTION } = evaluate;

function isIdentifierReference(node, parent) {
	if (parent.type === 'MemberExpression') return parent.computed || node === parent.object;

	// disregard the `bar` in { bar: foo }
	if (parent.type === 'Property') return node === parent.value;

	// disregard the `bar` in `class Foo { bar () {...} }`
	if (parent.type === 'MethodDefinition') return false;

	// disregard the `bar` in `export { foo as bar }`
  if (parent.type === 'ExportSpecifier') return false;

  // disregard the `bar` in var bar = asdf
  if (parent.type === 'VariableDeclarator') return parent.id !== node;

  // disregard the `bar` in `function (bar) {}`
  if (parent.type === 'FunctionExpression' || parent.type === 'FunctionDeclaration' || parent.type === 'ArrowFunctionExpression') return false;

	return true;
}

const stateMap = new Map();
let lastState;

function getAssetState (options, compilation) {
  let state = stateMap.get(compilation);
  if (!state) {
    stateMap.set(compilation, state = {
      entryId: getEntryId(compilation),
      assets: Object.create(null),
      assetNames: Object.create(null),
      assetPermissions: Object.create(null),
      hadOptions: false
    });
  }
  if (!state.hadOptions) {
    state.hadOptions = true;
    if (options && options.existingAssetNames) {
      options.existingAssetNames.forEach(assetName => {
        state.assetNames[assetName] = true;
      });
    }
  }
  return lastState = state;
}

function getEntryId (compilation) {
  if (compilation.options && typeof compilation.options.entry === 'string') {
    return resolve.sync(compilation.options.entry, { extensions });
  }
  if (compilation.entries && compilation.entries.length) {
    try {
      return resolve.sync(compilation.entries[0].name || compilation.entries[0].resource, { basedir: path.dirname(compilation.entries[0].context), extensions });
    }
    catch (e) {
      return;
    }
  }
  const entryMap = compilation.entryDependencies;
  if (entryMap)
    for (entry of entryMap.values()) {
      if (entry.length) {
        try {
          return resolve.sync(entry[0].request, { basedir: path.dirname(entry[0].context), extensions });
        }
        catch (e) {
          return;
        }
      }
    }
}

function assetBase (options) {
  const outputAssetBase = options && options.outputAssetBase;
  if (!outputAssetBase)
    return '';
  if (outputAssetBase.endsWith('/') || outputAssetBase.endsWith('\\'))
    return outputAssetBase;
  return outputAssetBase + '/';
}

function relAssetPath (context, options) {
  const isChunk = context._module.reasons && context._module.reasons.every(reason => reason.module);
  const filename = isChunk && context._compilation.outputOptions.chunkFilename || context._compilation.outputOptions.filename;
  const backtrackDepth = filename.split(/[\\/]/).length - 1;
  return '../'.repeat(backtrackDepth) + assetBase(options);
}

// unique symbol value to identify express instance in static analysis
const EXPRESS = Symbol();
const NBIND = Symbol();
const staticModules = Object.assign(Object.create(null), {
  express: {
    default: function () {
      return EXPRESS;
    }
  },
  path: staticPath,
  os: {
    default: os,
    ...os
  },
  'node-pre-gyp': pregyp,
  'node-pre-gyp/lib/pre-binding': pregyp,
  'node-pre-gyp/lib/pre-binding.js': pregyp,
  'nbind': {
    default: NBIND
  }
});

module.exports = async function (content, map) {
  if (this.cacheable)
    this.cacheable();
  this.async();
  const id = this.resourcePath;
  const dir = path.dirname(id);
  if (id.endsWith('.node')) {
    const options = getOptions(this);
    const assetState = getAssetState(options, this._compilation);
    const pkgBase = getPackageBase(this.resourcePath) || dir;
    await sharedlibEmit(pkgBase, assetState, assetBase(options), this.emitFile);

    const name = getUniqueAssetName(id.substr(pkgBase.length + 1), id, assetState.assetNames);
    
    const permissions = await new Promise((resolve, reject) => 
      stat(id, (err, stats) => err ? reject(err) : resolve(stats.mode))
    );
    assetState.assetPermissions[name] = permissions;
    this.emitFile(assetBase(options) + name, content);

    this.callback(null, 'module.exports = __non_webpack_require__("./' + relAssetPath(this, options) + JSON.stringify(name).slice(1, -1) + '")');
    return;
  }

  if (id.endsWith('.json'))
    return this.callback(null, code, map);

  let code = content.toString();

  const specialCase = handleSpecialCase(id, code);

  const options = getOptions(this);
  const assetState = getAssetState(options, this._compilation);
  const entryId = assetState.entryId;

  // calculate the base-level package folder to load bindings from
  const pkgBase = getPackageBase(id);

  let staticBindingsInstance = false;
  function createBindings () {
    return (opts = {}) => {
      if (typeof opts === 'string')
        opts = { bindings: opts };
      if (!opts.path) {
        opts.path = true;
        staticBindingsInstance = true;
      }
      opts.module_root = pkgBase;
      return bindings(opts);
    };
  }

  const emitAsset = (assetPath) => {
    // JS assets to support require(assetPath) and not fs-based handling
    // NB package.json is ambiguous here...
    let outName = path.basename(assetPath);

    if (assetPath.endsWith('.node')) {
      // retain directory depth structure for binaries for rpath to work out
      if (pkgBase)
        outName = assetPath.substr(pkgBase.length).replace(/\\/g, '/');
      // If the asset is a ".node" binary, then glob for possible shared
      // libraries that should also be included
      const nextPromise = sharedlibEmit(pkgBase, assetState, assetBase(options), this.emitFile);
      assetEmissionPromises = assetEmissionPromises.then(() => {
        return nextPromise;
      });
    }

    const name = assetState.assets[assetPath] ||
        (assetState.assets[assetPath] = getUniqueAssetName(outName, assetPath, assetState.assetNames));

    if (options.debugLog)
      console.log('Emitting ' + assetPath + ' for static use in module ' + id);
    assetEmissionPromises = assetEmissionPromises.then(async () => {
      const [source, stats] = await Promise.all([
        new Promise((resolve, reject) =>
          readFile(assetPath, (err, source) => err ? reject(err) : resolve(source))
        ),
        await new Promise((resolve, reject) => 
          lstat(assetPath, (err, stats) => err ? reject(err) : resolve(stats))
        )
      ]);
      if (stats.isSymbolicLink()) {
        const symlink = await new Promise((resolve, reject) => {
          readlink(assetPath, (err, path) => err ? reject(err) : resolve(path));
        });
        const baseDir = path.dirname(assetPath);
        assetState.assetSymlinks[assetBase(options) + name] = path.relative(baseDir, path.resolve(baseDir, symlink));
      }
      else {
        assetState.assetPermissions[assetBase(options) + name] = stats.mode;
        this.emitFile(assetBase(options) + name, source);
      }
    });
    return "__dirname + '/" + relAssetPath(this, options) + JSON.stringify(name).slice(1, -1) + "'";
  };
  const emitAssetDirectory = (assetDirPath) => {
    if (options.debugLog)
      console.log('Emitting directory ' + assetDirPath + ' for static use in module ' + id);
    const dirName = path.basename(assetDirPath);
    const name = assetState.assets[assetDirPath] || (assetState.assets[assetDirPath] = getUniqueAssetName(dirName, assetDirPath, assetState.assetNames));
    assetState.assets[assetDirPath] = name;

    assetEmissionPromises = assetEmissionPromises.then(async () => {
      const files = await new Promise((resolve, reject) =>
        glob(assetDirPath + '/**/*', { mark: true, ignore: 'node_modules/**/*' }, (err, files) => err ? reject(err) : resolve(files))
      );
      await Promise.all(files.map(async file => {
        // dont emit empty directories or ".js" files
        if (file.endsWith('/') || file.endsWith('.js'))
          return;
        const [source, stats] = await Promise.all([
          new Promise((resolve, reject) =>
            readFile(file, (err, source) => err ? reject(err) : resolve(source))
          ),
          await new Promise((resolve, reject) => 
            lstat(file, (err, stats) => err ? reject(err) : resolve(stats))
          )
        ]);
        if (stats.isSymbolicLink()) {
          const symlink = await new Promise((resolve, reject) => {
            readlink(file, (err, path) => err ? reject(err) : resolve(path));
          });
          const baseDir = path.dirname(file);
          assetState.assetSymlinks[assetBase(options) + name + file.substr(assetDirPath.length)] = path.relative(baseDir, path.resolve(baseDir, symlink));
        }
        else {
          assetState.assetPermissions[assetBase(options) + name + file.substr(assetDirPath.length)] = stats.mode;
          this.emitFile(assetBase(options) + name + file.substr(assetDirPath.length), source);
        }
      }));
    });

    return "__dirname + '/" + relAssetPath(this, options) + JSON.stringify(name).slice(1, -1) + "'";
  };

  let assetEmissionPromises = Promise.resolve();

  const magicString = new MagicString(code);

  let ast, isESM;
  try {
    ast = acorn.parse(code, { allowReturnOutsideFunction: true });
    isESM = false;
  }
  catch (e) {}
  if (!ast) {
    try {
      ast = acorn.parse(code, { sourceType: 'module' });
      isESM = true;
    }
    catch (e) {
      this.callback(e);
      return;
    }
  }

  let scope = attachScopes(ast, 'scope');

  let transformed = false;

  if (specialCase) {
    transformed = specialCase({ code, ast, scope, magicString, emitAsset, emitAssetDirectory });
  }

  const knownBindings = Object.assign(Object.create(null), {
    __dirname: {
      shadowDepth: 0,
      value: path.resolve(id, '..')
    },
    __filename: {
      shadowDepth: 0,
      value: id
    },
    process: {
      shadowDepth: 0,
      value: {   
        env: {
          NODE_ENV: typeof options.production === 'boolean' ? (options.production ? 'production' : 'dev') : UNKNOWN,
          [UNKNOWN]: true
        },
        [UNKNOWN]: true
      }
    }
  });

  if (!isESM)
    knownBindings.require = {
      shadowDepth: 0,
      value: {
        [FUNCTION]: [UNKNOWN],
        resolve (specifier) {
          return resolve.sync(specifier, { basedir: dir, extensions });
        }
      }
    };

  function setKnownBinding (name, value) {
    // require is somewhat special in that we shadow it but don't
    // statically analyze it ("known unknown" of sorts)
    if (name === 'require') return;
    knownBindings[name] = {
      shadowDepth: 0,
      value: value
    };
  }
  function getKnownBinding (name) {
    const binding = knownBindings[name];
    if (binding) {
      if (binding.shadowDepth === 0) {
        return binding.value;
      }
    }
  }

  let pregypId, bindingsId, resolveFromId;

  if (isESM) {
    for (const decl of ast.body) {
      if (decl.type === 'ImportDeclaration') {
        const source = decl.source.value;
        const staticModule = staticModules[source];
        if (staticModule) {
          for (const impt of decl.specifiers) {
            let bindingId;
            if (impt.type === 'ImportNamespaceSpecifier')
              setKnownBinding(bindingId = impt.local.name, staticModule);
            else if (impt.type === 'ImportDefaultSpecifier' && 'default' in staticModule)
              setKnownBinding(bindingId = impt.local.name, staticModule.default);
            else if (impt.type === 'ImportSpecifier' && impt.imported.name in staticModule)
              setKnownBinding(bindingId = impt.local.name, staticModule[impt.imported.name]);

            if (source === 'bindings')
              bindingsId = bindingId;
            else if (source === 'node-pre-gyp' || source === 'node-pre-gyp/lib/pre-binding' || source === 'node-pre-gyp/lib/pre-binding.js')
              pregypId = bindingId;
            else if (source === 'resolve-from')
              resovleFromId = bindingId;
          }
        }
      }
    }
  }

  function computePureStaticValue (expr) {
    staticBindingsInstance = false;
    const vars = Object.create(null);
    Object.keys(knownBindings).forEach(name => {
      vars[name] = getKnownBinding(name);
    });

    // evaluate returns undefined for non-statically-analyzable
    return evaluate(expr, vars);
  }

  // statically determinable leaves are tracked, and inlined when the
  // greatest parent statically known leaf computation corresponds to an asset path
  let staticChildNode, staticChildValue, staticChildValueBindingsInstance;

  // Express engine opt-out
  let definedExpressEngines = false;

  // detect require('asdf');
  function isStaticRequire (node) {
    return node &&
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        knownBindings.require.shadowDepth === 0 &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'Literal';
  }

  if (options.wrapperCompatibility) {
    ({ ast, scope, transformed: wrapperTransformed } = handleWrappers(ast, scope, magicString, code.length));
    if (wrapperTransformed)
      transformed = true;
  }

  walk(ast, {
    enter (node, parent) {
      if (node.scope) {
        scope = node.scope;
        for (const id in node.scope.declarations) {
          if (id in knownBindings)
            knownBindings[id].shadowDepth++;
        }
      }

      if (staticChildNode)
        return this.skip();

      let computed;

      if (node.type === 'Identifier') {
        if (isIdentifierReference(node, parent)) {
          let binding;
          // detect asset leaf expression triggers (if not already)
          // __dirname,  __filename, binary only currently as well as require('bindings')(...)
          // Can add require.resolve, import.meta.url, even path-like environment variables
          if (typeof (binding = getKnownBinding(node.name)) === 'string' &&
              path.isAbsolute(binding) || node.name === pregypId || node.name === bindingsId) {
            staticChildValue = { value: binding };
            // if it computes, then we start backtracking
            if (staticChildValue) {
              staticChildNode = node;
              staticChildValueBindingsInstance = staticBindingsInstance;
              return this.skip();
            }
          }
          // free require -> __non_webpack_require__
          else if (!isESM && node.name === 'require' && knownBindings.require.shadowDepth === 0 && parent.type !== 'UnaryExpression') {
            magicString.overwrite(node.start, node.end, '__non_webpack_require__');
            transformed = true;
            return this.skip();
          }
          // __non_webpack_require__ -> eval('require')
          else if (!isESM && node.name === '__non_webpack_require__' && parent.type !== 'UnaryExpression') {
            magicString.overwrite(node.start, node.end, 'eval("require")');
            transformed = true;
            return this.skip();
          }
        }
      }
      // require
      else if (!isESM &&
               node.type === 'CallExpression' &&
               node.callee.type === 'Identifier' &&
               node.callee.name === 'require' &&
               knownBindings.require.shadowDepth === 0 &&
               node.arguments.length) {
        const expression = node.arguments[0];
        const { result: computed, sawIdentifier } = computePureStaticValue(expression);
        // no clue what the require is for, Webpack won't know either
        // -> turn it into a runtime dynamic require
        if (!computed) {
          // require(a || 'asdf') -> require('asdf') special case
          if (expression.type === 'LogicalExpression' && expression.operator === '||' &&
              expression.left.type === 'Identifier') {
            transformed = true;
            magicString.overwrite(expression.start, expression.end, code.substring(expression.right.start, expression.right.end));
            return this.skip();
          }
          transformed = true;
          magicString.overwrite(node.callee.start, node.callee.end, '__non_webpack_require__');
          return this.skip();
        }
        // we found the exact value for the require, and it used a binding from our analysis
        // -> inline the computed value for Webpack to use
        else if (typeof computed.value === 'string' && sawIdentifier) {
          transformed = true;
          magicString.overwrite(expression.start, expression.end, JSON.stringify(computed.value));
          return this.skip();
        }
        // branched require, and it used a binding from our analysis
        // -> inline the computed values for Webpack
        else if (computed && typeof computed.then === 'string' && typeof computed.else === 'string' && sawIdentifier) {
          const conditionValue = computePureStaticValue(computed.test).result;
          // inline the known branch if possible
          if (conditionValue && 'value' in conditionValue) {
            if (conditionValue) {
              transformed = true;
              magicString.overwrite(expression.start, expression.end, JSON.stringify(computed.then));
              return this.skip();
            }
            else {
              transformed = true;
              magicString.overwrite(expression.start, expression.end, JSON.stringify(computed.else));
              return this.skip();
            }
          }
          else {
            const test = code.substring(computed.test.start, computed.test.end);
            transformed = true;
            magicString.overwrite(expression.start, expression.end, `${test} ? ${JSON.stringify(computed.then)} : ${JSON.stringify(computed.else)}`);
            return this.skip();
          }
        }
        // Special cases
        else if (parent.type === 'CallExpression' && parent.callee === node) {
          // require('bindings')('asdf')
          if (computed.value === 'bindings') {
            let staticValue = computePureStaticValue(parent.arguments[0]).result;
            let bindingsValue;
            if (staticValue && 'value' in staticValue) {
              try {
                bindingsValue = createBindings()(staticValue.value);
              }
              catch (err) {}
            }
            if (bindingsValue) {
              staticChildValue = { value: bindingsValue };
              staticChildNode = parent;
              staticChildValueBindingsInstance = staticBindingsInstance;
              return this.skip();
            }
          }
          // require('pkginfo')(module, ...string[])
          else if (computed.value === 'pkginfo' &&
                  parent.arguments.length &&
                  parent.arguments[0].type === 'Identifier' &&
                  parent.arguments[0].name === 'module') {
            let filterValues = new Set();
            for (let i = 1; i < parent.arguments.length; i++) {
              if (parent.arguments[i].type === 'Literal')
                filterValues.add(parent.arguments[i].value);
            }
            const scope = getPackageScope(id);
            if (scope) {
              try {
                var pkg = JSON.parse(readFileSync(scope + '/package.json'));
                if (filterValues.size) {
                  for (var p in pkg) {
                    if (!filterValues.has(p))
                      delete pkg[p];
                  }
                }
              }
              catch (e) {}
              if (pkg) {
                transformed = true;
                magicString.overwrite(parent.start, parent.end, `Object.assign(module.exports, ${JSON.stringify(pkg)})`);
                return this.skip();
              }
            }
          }
          // leave it to webpack
          return this.skip();
        }
        else {
          // leave it to webpack
          return this.skip();
        }
      }
      // require.main handling
      else if (!isESM && node.type === 'MemberExpression' &&
               node.object.type === 'Identifier' &&
               node.object.name === 'require' &&
               knownBindings.require.shadowDepth === 0 &&
               node.property.type === 'Identifier' &&
               !node.computed) {
        if (node.property.name === 'main' &&
            parent && parent.type === 'BinaryExpression' &&
            (parent.operator === '==' || parent.operator === '===')) {
          let other;
          other = parent.right === node ? parent.left : parent.right;
          if (other.type === 'Identifier' && other.name === 'module') {
            // inline the require.main check to be the target require.main check if this is the entry,
            // and false otherwise
            if (id === entryId) {
              // require.main === module -> __non_webpack_require__.main == __non_webpack_require__.cache[eval('__filename')]
              // can be simplified if we get a way to get outer "module" in Webpack
              magicString.overwrite(other.start, other.end, "__non_webpack_require__.cache[eval('__filename')]");
            }
            else {
              magicString.overwrite(parent.start, parent.end, "false");
              transformed = true;
              return this.skip();
            }
          }
        }
        if (node.property.name === 'ensure') {
          // leave require.ensure to webpack
          return this.skip();
        }
      }
      else if (!isESM && node.type === 'CallExpression' &&
               node.callee.type === 'MemberExpression' &&
               node.callee.object.type === 'Identifier' &&
               node.callee.object.name === 'require' &&
               node.callee.property.type === 'Identifier' &&
               node.callee.property.name === 'resolve' &&
               node.callee.computed === false &&
               node.arguments.length) {
        // require.resolve analysis
        staticChildValue = computePureStaticValue(node).result;
        // if it computes, then we start backtracking
        if (staticChildValue) {
          staticChildNode = node;
          staticChildValueBindingsInstance = staticBindingsInstance;
          return this.skip();
        }
      }
      // X = ... and
      // var X = ... get computed
      else if (parent && parent.type === 'VariableDeclarator' &&
               parent.init === node && parent.id.type === 'Identifier' && 
               (computed = computePureStaticValue(node).result) ||
               parent && parent.type === 'AssignmentExpression' &&
               parent.right === node && parent.left.type === 'Identifier' &&
               (computed = computePureStaticValue(node).result)) {
        const bindingName = parent.id ? parent.id.name : parent.left.name;
        if (!computed.test)
          setKnownBinding(bindingName, computed.value);
        if (typeof computed.value === 'string' && path.isAbsolute(computed.value)) {
          staticChildValue = computed;
          staticChildNode = node;
          staticChildValueBindingsInstance = staticBindingsInstance;
          return this.skip();
        }
      }
      else if (node.type === 'VariableDeclaration') {
        for (const decl of node.declarations) {
          let binding;
          if (!isESM && isStaticRequire(decl.init)) {
            const source = decl.init.arguments[0].value;
            if (source === 'resolve-from')
              resolveFromId = decl.id.name;
            let staticModule;
            if (source === 'bindings')
              staticModule = { default: createBindings() };
            else
              staticModule = staticModules[source];
            if (staticModule) {
              // var known = require('known');
              if (decl.id.type === 'Identifier') {
                setKnownBinding(decl.id.name, staticModule.default);
                if (source === 'bindings')
                  bindingsId = decl.id.name;
                else if (source === 'node-pre-gyp' || source === 'node-pre-gyp/lib/pre-binding' || source === 'node-pre-gyp/lib/pre-binding.js')
                  pregypId = decl.id.name;
              }
              // var { known } = require('known);
              else if (decl.id.type === 'ObjectPattern') {
                for (const prop of decl.id.properties) {
                  if (prop.type !== 'Property' ||
                      prop.key.type !== 'Identifier' ||
                      prop.value.type !== 'Identifier' ||
                      !(prop.key.name in staticModule))
                    continue;
                  setKnownBinding(prop.value.name, staticModule[prop.key.name]);
                }
              }
            }
          }
          // var { knownProp } = known;
          else if (decl.id.type === 'ObjectPattern' &&
                   decl.init && decl.init.type === 'Identifier' &&
                   (binding = getKnownBinding(decl.init.name)) !== undefined) {
            for (const prop of decl.id.properties) {
              if (prop.type !== 'Property' ||
                prop.key.type !== 'Identifier' ||
                prop.value.type !== 'Identifier' ||
                typeof binding !== 'object' ||
                typeof binding !== 'function' ||
                binding === null ||
                !(prop.key.name in binding))
              continue;
              setKnownBinding(prop.value.name, binding[prop.key.name]);
            }
          }
        }
      }
      else if (node.type === 'AssignmentExpression') {
        // path = require('path')
        if (!isESM && isStaticRequire(node.right) &&
            node.right.arguments[0].value in staticModules &&
            node.left.type === 'Identifier' && scope.declarations[node.left.name]) {
          setKnownBinding(node.left.name, staticModules[node.right.arguments[0].value]);
        }
        // require = require('esm')(...)
        else if (!isESM && node.right.type === 'CallExpression' &&
            isStaticRequire(node.right.callee) &&
            node.right.callee.arguments[0].value === 'esm' &&
            node.left.type === 'Identifier' && node.left.name === 'require') {
          transformed = true;
          magicString.overwrite(node.start, node.end, '');
          return this.skip();
        }
      }
      // condition ? require('a') : require('b')
      // attempt to inline known branch based on variable analysis
      else if (!isESM && node.type === 'ConditionalExpression' && isStaticRequire(node.consequent) && isStaticRequire(node.alternate)) {
        const computed = computePureStaticValue(node.test).result;
        if (computed && 'value' in computed) {
          transformed = true;
          if (computed.value) {
            magicString.overwrite(node.start, node.end, code.substring(node.consequent.start, node.consequent.end));
          }
          else {
            magicString.overwrite(node.start, node.end, code.substring(node.alternate.start, node.alternate.end));
          }
          return this.skip();
        }
      }
      // resolveFrom(__dirname, ...) -> require.resolve(...)
      else if (resolveFromId && node.type === 'CallExpression' &&
          node.callee.type === 'Identifier' && node.callee.name === resolveFromId &&
          node.arguments.length === 2 && node.arguments[0].type === 'Identifier' &&
          node.arguments[0].name === '__dirname' && knownBindings.__dirname.shadowDepth === 0) {
        transformed = true;
        magicString.overwrite(node.start, node.arguments[0].end + 1, 'require.resolve(');
        return this.skip();
      }
      // nbind.init(...) -> require('./resolved.node')
      else if (node.type === 'CallExpression' &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          getKnownBinding(node.callee.object.name) === NBIND &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'init') {
        const staticValue = computePureStaticValue(node).result;
        let bindingInfo;
        if (staticValue && 'value' in staticValue)
          bindingInfo = staticValue.value;
        if (bindingInfo) {
          bindingInfo.path = path.relative(dir, bindingInfo.path);
          transformed = true;
          const bindingPath = JSON.stringify(bindingInfo.path.replace(/\\/g, '/'));
          magicString.overwrite(node.start, node.end, `({ bind: require(${bindingPath}).NBind.bind_value, lib: require(${bindingPath}) })`);
          return this.skip();
        }
      }
      // Express templates:
      // app.set("view engine", [name]) -> app.engine([name], require([name]).__express).set("view engine", [name])
      // app.engine('name', ...) causes opt-out of rewrite
      else if (node.type === 'CallExpression' &&
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          getKnownBinding(node.callee.object.name) === EXPRESS &&
          node.callee.property.type === 'Identifier') {
        if (node.callee.property.name === 'engine') {
          definedExpressEngines = true;
        }
        else if (node.callee.property.name === 'set' &&
            node.arguments.length === 2 &&
            node.arguments[0].type === 'Literal' &&
            node.arguments[0].value === 'view engine' &&
            !definedExpressEngines) {
          transformed = true;
          const name = code.substring(node.arguments[1].start, node.arguments[1].end);
          magicString.appendRight(node.callee.object.end, `.engine(${name}, require(${name}).__express)`);
          return this.skip();
        }
      }
    },
    leave (node, parent) {
      if (node.scope) {
        scope = scope.parent;
        for (const id in node.scope.declarations) {
          if (id in knownBindings) {
            if (knownBindings[id].shadowDepth > 0)
              knownBindings[id].shadowDepth--;
            else
              delete knownBindings[id];
          }
        }
      }

      // computing a static expression outward
      // -> compute and backtrack
      if (staticChildNode) {
        const curStaticValue = computePureStaticValue(node).result;
        if (curStaticValue) {
          staticChildValue = curStaticValue;
          staticChildNode = node;
          staticChildValueBindingsInstance = staticBindingsInstance;
          return;
        }
        // no static value -> see if we should emit the asset if it exists
        // Currently we only handle files. In theory whole directories could also be emitted if necessary.
        if ('value' in staticChildValue) {
          let resolved;
          try { resolved = path.resolve(staticChildValue.value); }
          catch (e) {}
          if (resolved === '/') {
            resolved = null;
          }
          // don't emit the filename of this module itself or a direct uncontextual __dirname
          if (resolved && resolved !== id && !(staticChildNode.type === 'Identifier' && staticChildNode.name === '__dirname')) {
            const inlineString = getInlined(inlineType(resolved), resolved);
            if (inlineString) {
              magicString.overwrite(staticChildNode.start, staticChildNode.end, inlineString);
              transformed = true;
            }
          }
        }
        else {
          let resolvedThen;
          try { resolvedThen = path.resolve(staticChildValue.then); }
          catch (e) {}
          let resolvedElse;
          try { resolvedElse = path.resolve(staticChildValue.else); }
          catch (e) {}
          const thenInlineType = inlineType(resolvedThen);
          const elseInlineType = inlineType(resolvedElse);
          // only inline conditionals when both branches are known inlinings
          if (thenInlineType && elseInlineType) {
            const thenInlineString = getInlined(thenInlineType, resolvedThen);
            const elseInlineString = getInlined(elseInlineType, resolvedElse);
            magicString.overwrite(
              staticChildNode.start, staticChildNode.end,
              `${code.substring(staticChildValue.test.start, staticChildValue.test.end)} ? ${thenInlineString} : ${elseInlineString}`
            );
            transformed = true;
          }
        }
        function inlineType (value) {
          let stats;
          if (typeof value === 'string') {
            try {
              stats = statSync(value);
            }
            catch (e) {
            }
          }
          else if (typeof value === 'boolean')
            return 'value';
          if (stats && stats.isFile())
            return 'file';
          else if (stats && stats.isDirectory())
            return 'directory';
        }
        function getInlined (inlineType, value) {
          switch (inlineType) {
            case 'value': return value;
            case 'file':
              let replacement = emitAsset(value);
              // require('bindings')(...)
              // -> require(require('bindings')(...))
              if (staticChildValueBindingsInstance)
                replacement = '__non_webpack_require__(' + replacement + ')';
              return replacement;
            case 'directory':
              // do not emit asset directories higher than the package base itself
              if (!pkgBase || value.startsWith(pkgBase))
                return emitAssetDirectory(value);
              else if (options.debugLog)
                console.log('Skipping asset emission of ' + value + ' directory for ' + id + ' as it is outside the package base ' + pkgBase);

          }
        }
        staticChildNode = staticChildValue = undefined;
      }
    }
  });

  if (!transformed)
    return this.callback(null, code, map);

  assetEmissionPromises.then(() => {
    code = magicString.toString();
    map = map || magicString.generateMap();
    if (map) {
      map.sources = [id];
      // map.sources = map.sources.map(name => name.indexOf('!') !== -1 ? name.split('!')[1] : name);
    }
    this.callback(null, code, map);
  });
};

module.exports.raw = true;
module.exports.getAssetPermissions = function(assetName) {
  if (lastState)
    return lastState.assetPermissions[assetName];
};
module.exports.getSymlinks = function() {
  if (lastState)
    return lastState.assetSymlinks;
};

module.exports.initAssetPermissionsCache = function (compilation) {
  const entryId = getEntryId(compilation);
  if (!entryId)
    return;
  const state = lastState = {
    entryId: entryId,
    assets: Object.create(null),
    assetNames: Object.create(null),
    assetPermissions: Object.create(null),
    assetSymlinks: Object.create(null),
    hadOptions: false
  };
  stateMap.set(compilation, state);
  compilation.cache.get('/RelocateLoader/AssetState/' + entryId, null, (err, _assetState) => {
    if (err) console.error(err);
    if (_assetState) {
      const parsedState = JSON.parse(_assetState);
      if (parsedState.assetPermissions)
        state.assetPermissions = parsedState.assetPermissions;
      if (parsedState.assetSymlinks)
        state.assetSymlinks = parsedState.assetSymlinks;
    }
  });
  compilation.compiler.hooks.afterCompile.tap("relocate-loader", compilation => {
    compilation.cache.store('/RelocateLoader/AssetState/' + entryId, null, JSON.stringify({
      assetPermissions: state.assetPermissions,
      assetSymlinks: state.assetSymlinks
    }), (err) => {
      if (err) console.error(err);
    });
  });
};
