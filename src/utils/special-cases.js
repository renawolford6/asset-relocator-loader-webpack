const path = require('path');
const resolve = require('resolve');

module.exports = function (id, _code) {
  if (id.endsWith('google-gax/build/src/grpc.js') || global._unit && id.includes('google-gax')) {
    return ({ ast, magicString, emitAssetDirectory }) => {
      // const googleProtoFilesDir = path.normalize(google_proto_files_1.getProtoPath('..'));
      // ->
      // const googleProtoFilesDir = path.resolve(__dirname, '../../../google-proto-files');
      for (const statement of ast.body) {
        if (statement.type === 'VariableDeclaration' &&
            statement.declarations[0].id.type === 'Identifier' &&
            statement.declarations[0].id.name === 'googleProtoFilesDir') {
          magicString.overwrite(statement.declarations[0].init.start, statement.declarations[0].init.end,
              emitAssetDirectory(path.resolve(path.dirname(id), global._unit ? './' : '../../../google-proto-files')));
          statement.declarations[0].init = null;
          return true;
        }
      }
    };
  }
  else if (id.endsWith('socket.io/lib/index.js') || global._unit && id.includes('socket.io')) {
    return ({ ast }) => {
      function replaceResolvePathStatement (statement) {
        if (statement.type === 'ExpressionStatement' &&
            statement.expression.type === 'AssignmentExpression' &&
            statement.expression.operator === '=' &&
            statement.expression.right.type === 'CallExpression' &&
            statement.expression.right.callee.type === 'Identifier' &&
            statement.expression.right.callee.name === 'read' &&
            statement.expression.right.arguments.length >= 1 &&
            statement.expression.right.arguments[0].type === 'CallExpression' &&
            statement.expression.right.arguments[0].callee.type === 'Identifier' &&
            statement.expression.right.arguments[0].callee.name === 'resolvePath' &&
            statement.expression.right.arguments[0].arguments.length === 1 &&
            statement.expression.right.arguments[0].arguments[0].type === 'Literal') {
          const arg = statement.expression.right.arguments[0].arguments[0].value;
          try {
            var resolved = resolve.sync(arg, { basedir: path.dirname(id) });
          }
          catch (e) {
            return false;
          }
          // The asset relocator will then pick up the AST rewriting from here
          const relResolved = '/' + path.relative(path.dirname(id), resolved);
          statement.expression.right.arguments[0] = {
            type: 'BinaryExpression',
            start: statement.expression.right.arguments[0].start,
            end: statement.expression.right.arguments[0].end,
            operator: '+',
            left: {
              type: 'Identifier',
              name: '__dirname'
            },
            right: {
              type: 'Literal',
              value: relResolved,
              raw: JSON.stringify(relResolved)
            }
          };
          return true;
        }
        return false;
      }

      for (const statement of ast.body) {
        if (statement.type === 'ExpressionStatement' &&
            statement.expression.type === 'AssignmentExpression' &&
            statement.expression.operator === '=' &&
            statement.expression.left.type === 'MemberExpression' &&
            statement.expression.left.object.type === 'MemberExpression' &&
            statement.expression.left.object.object.type === 'Identifier' &&
            statement.expression.left.object.object.name === 'Server' &&
            statement.expression.left.object.property.type === 'Identifier' &&
            statement.expression.left.object.property.name === 'prototype' &&
            statement.expression.left.property.type === 'Identifier' &&
            statement.expression.left.property.name === 'serveClient' &&
            statement.expression.right.type === 'FunctionExpression') {
          let ifStatement;
          for (const node of statement.expression.right.body.body)
            if (node.type === 'IfStatement') ifStatement = node;
          const ifBody = ifStatement && ifStatement.consequent.body;
          let replaced = false;
          if (ifBody && ifBody[0] && ifBody[0].type === 'ExpressionStatement')
            replaced = replaceResolvePathStatement(ifBody[0]);
          const tryBody = ifBody && ifBody[1] && ifBody[1].type === 'TryStatement' && ifBody[1].block.body;
          if (tryBody && tryBody[0])
            replaced = replaceResolvePathStatement(tryBody[0]) || replaced;
          return replaced;
        }
      }
    };
  }
  else if (id.endsWith('oracledb/lib/oracledb.js') || global._unit && id.includes('oracledb')) {
    return ({ ast, magicString }) => {
      for (const statement of ast.body) {
        if (statement.type === 'ForStatement' &&
            statement.body.body &&
            statement.body.body[0] &&
            statement.body.body[0].type === 'TryStatement' &&
            statement.body.body[0].block.body[0] &&
            statement.body.body[0].block.body[0].type === 'ExpressionStatement' &&
            statement.body.body[0].block.body[0].expression.type === 'AssignmentExpression' &&
            statement.body.body[0].block.body[0].expression.operator === '=' &&
            statement.body.body[0].block.body[0].expression.left.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.left.name === 'oracledbCLib' &&
            statement.body.body[0].block.body[0].expression.right.type === 'CallExpression' &&
            statement.body.body[0].block.body[0].expression.right.callee.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.right.callee.name === 'require' &&
            statement.body.body[0].block.body[0].expression.right.arguments.length === 1 &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].type === 'MemberExpression' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].computed === true &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].object.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].object.name === 'binaryLocations' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].property.type === 'Identifier' &&
            statement.body.body[0].block.body[0].expression.right.arguments[0].property.name === 'i') {
          const arg = statement.body.body[0].block.body[0].expression.right.arguments[0];
          statement.body.body[0].block.body[0].expression.right.arguments = [];
          const binaryName = 'oracledb-abi' + process.versions.modules + '-' + process.platform + '-' + process.arch + '.node';
          magicString.overwrite(arg.start, arg.end, global._unit ? "'./oracledb.js'" : "'../build/Release/" + binaryName + "'");
          return true;
        }
      }
    };
  }
  else if (id.endsWith('@ffmpeg-installer/ffmpeg/index.js') || global._unit && id.includes('ffmpeg')) {
    return ({ ast, magicString }) => {
      for (const statement of ast.body) {
        if (statement.type === 'IfStatement' &&
            statement.test.type === 'CallExpression' &&
            statement.test.callee.type === 'Identifier' &&
            statement.test.callee.name === 'verifyFile') {
          magicString.overwrite(statement.test.start, statement.test.end, 'true');
          statement.test = { type: 'Literal', value: true, start: statement.test.start, end: statement.test.end };
          return true;
        }
      }
    };
  }
};
