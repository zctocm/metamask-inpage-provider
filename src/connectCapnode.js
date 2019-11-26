const Capnode = require('capnode').default;
const capnode = new Capnode({})
const remote = capnode.createRemote();

module.exports = function connectCapnode () {
  return [capnode, remote];
}
