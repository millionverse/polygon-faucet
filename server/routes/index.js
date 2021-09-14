var config = require("../config.json");
var Web3 = require("web3");
// var config = require("./config.json");

const mkdirp = require("mkdirp");
const level = require("level");

mkdirp.sync(require("os").homedir() + "/.maticfaucet/exceptions");

const dbEthExceptions = level(
    require("os").homedir() + "/.maticfaucet/exceptions/eth"
);

const dbAddress = level(
    require("os").homedir() + "/.maticfaucet/addresses"
);

const db = {}
db['matic'] = dbEthExceptions

const addr_db = {}
addr_db['matic'] = dbAddress

const greylistduration = config.greylistdurationinsec * 1000; // time in ms
const claimintervalinsec = config.claimintervalinsec * 1000; // time in ms


const axios = require("axios")

const axios_config = {
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
    }
}

// check for valid Eth address
function isAddress(address) {
    return /^(0x)?[0-9a-f]{40}$/i.test(address);
}

// strip any spaces and add 0x
function fixaddress(address) {
  console.log('fixaddress', address);
  address = address.replace(" ", "");
  address = address.toLowerCase();
  if (!strStartsWith(address, "0x")) {
    return "0x" + address;
  }
  return address;
}

// helper
function strStartsWith(str, prefix) {
    return str.indexOf(prefix) === 0;
}

let web3Objects = {};

for (let network in config.networks) {
    console.log(network)
    let currentNetwork = config.networks[network]
    console.log(currentNetwork.rpc)
    console.log('connecting to', network)
    web3 = new Web3(currentNetwork.rpc)
    console.log('adding key')
    web3.eth.accounts.wallet.add(currentNetwork.privateKey)
    console.log('wallet addr=', web3.eth.accounts.wallet[0].address)
    web3Objects[network] = web3
    console.log('---')
}

function getEthBalance(web3) {
    return (web3.eth.getBalance(web3.eth.accounts.wallet[0].address))
}

function getAccountBalance(account) {
    let web3 = web3Objects["rpc-mainnet"];
    return (web3.eth.getBalance(account))
}

async function getFaucetBalance() {
    let balances = [];
    for (let obj in web3Objects) {
        let web3 = web3Objects[obj]

        let rEth = await getEthBalance(web3)

        balances.push({
            "network": web3.currentProvider.host.replace("https://", "").replace(".matic.network", ""),
            "account": web3.eth.accounts.wallet[0].address,
            "balanceEth": web3.utils.fromWei(rEth, 'ether')
        });
    }
    return balances
}

async function getTokenInfo() {
    let tokenInfo = []

    for (let network in config.networks) {
        let _payoutEth

        tokenInfo.push({
            network: network,
            payoutEth: _payoutEth,
        })
    }

    return tokenInfo
}

function getException(address, token) {
    return new Promise((resolve, reject) => {
        db[token].get(address, function (err, value) {
            if (err) {
                if (err.notFound) {
                    return resolve()
                }
                return reject(err)
            }
            value = JSON.parse(value)
            return resolve(value);
        })
    })
}

function setException(address, token) {
    console.log("adding", address, "to greylist")
    let claimCount = 1;
    return getException(address, token).then((exception) => {
        if (exception) {
            claimCount = claimCount + exception.claimCount;
        }
        return new Promise((resolve, reject) => {
            db[token].put(
                address,
                JSON.stringify({
                    created: Date.now(),
                    reason: 'greylist',
                    address: address,
                    claimCount: claimCount
                }),
                function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                }
            )
        })
    });
}

function getLogs(address, token) {
    return new Promise((resolve, reject) => {
        addr_db[token].get(address, function (err, value) {
            if (err) {
                if (err.notFound) {
                    return resolve()
                }
                return reject(err)
            }
            value = JSON.parse(value)
            return resolve(value);
        })
    })
}

function setLogs(ip, address, token) {
    let claimCount = 1;
    return getLogs(address, token).then((entry) => {
        if (entry) {
            claimCount = claimCount + entry.claimCount;
        }
        return new Promise((resolve, reject) => {
            addr_db[token].put(
                address,
                JSON.stringify({
                    ip: ip,
                    claimCount: claimCount
                }),
                function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                }
            )
        })
    });
}

function cleanupExceptions(token) {
    var stream = db[token].createReadStream({
        keys: true,
        values: true
    }).on("data", item => {
        const value = JSON.parse(item.value);
        if (value.created < Date.now() - greylistduration) {
            db[token].del(item.key, err => {
                console.log("removed ", item.key, "from greylist.");
            })
        }
    })
}

// exception monitor
setInterval(() => {
    cleanupExceptions('matic')
}, config.checkfreqinsec * 100);


async function startTransfer(ip, address, token, amount, network) {
    let addressException = await getException(address, token)
    let ipException = await getException(ip, token)

    let exception = addressException || ipException

    if (exception && exception.claimCount >= 3) {
        console.log(exception.address, "is on the greylist");
        var values = {
            address: exception.address,
            message: "This account has already received funds 3 times today, come back tomorrow",
            duration: (exception.created + greylistduration) - Date.now()
        }
        return Promise.reject(values)
    }
    else if (exception && exception.created > Date.now() - claimintervalinsec) {
        console.log(exception.address, "has aleady claimed in the past 15 minutes");
        var values = {
            address: exception.address,
            message: "This account has already received funds in the last 15 minutes",
            duration: (exception.created + claimintervalinsec) - Date.now()
        }
        return Promise.reject(values)
    }

    let balanceException = await getAccountBalance(address) >= config.networks[network].tokens[token].maxbalance;
    if (balanceException) {
        console.log(address, "has a too high balance");
        var values = {
            message: "you already have a sufficient balance to use Polygon network",
        }
        return Promise.reject(values)
    }

    let receipt = await _startTransfer(address, token, amount, network)

    await setException(address, token)
    await setException(ip, token)
    await setLogs(ip, address, token)

    return receipt
}

async function _startTransfer(address, token, amount, network) {
    if (token === 'matic') return transferEth(address, amount, network)
}

async function transferEth(_to, _amount, network) {
    console.log('---start tx---')
    let web3 = web3Objects[network]
    let _from = web3.eth.accounts.wallet[0].address
    let _gasPrice = await web3.eth.getGasPrice();
    let amt = (_amount * Math.pow(10, 18)).toString()
    var options = {
        from: _from,
        to: _to,
        value: amt,
        gas: 314150,
        gasPrice: _gasPrice
    }
    console.log(options.to);
    let r = await web3.eth.sendTransaction(options)
        .on('receipt', (receipt) => {
            console.log('transfer successful!', receipt.transactionHash)
        })
        .on('error', (err) => {
            return Promise.reject(err);
        })
    console.log('---end tx---')
    return Promise.resolve(r.transactionHash);
}

module.exports = (express) => {
  // Create express Router
  var router = express.Router();

  router.route('/info')
    .get(function (req, res) {
      var ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      console.log("client IP=", ip);
      getFaucetBalance().then((r) => {
          res.status(200).json({
              checkfreqinsec: config.checkfreqinsec,
              greylistdurationinsec: config.greylistdurationinsec,
              balances: r
          })
      })
  })

  router.route('/tokenInfo')
    .get(function (req, res) {
      var ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      console.log("client IP=", ip);
      getTokenInfo().then((r) => {
          res.status(200).json({
              tokenInfo: r
          })
      })
  })


  // add routes
  router.route('/faucet')
    .post(function (req, res) {
      let network = req.body.network
      let token = req.body.token
      let captcha = req.body.captcha
      let account = req.body.account[0]

      console.log('route faucet', network, token, captcha, account);


      const params = new URLSearchParams()
      params.append('secret', config.hcaptchasecret)
      params.append('response', captcha)

      axios
        .post("https://hcaptcha.com/siteverify", params, axios_config)
        .then(response => {
          if (response.status === 200 && response.data.success == true) {
            var ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
            console.log("client IP=", ip);
            // let network = req.params.network
            // let token = req.params.token
            // let address = req.params.address
            let amount = config.networks[network].tokens[token].payoutamount
            if (!isAddress(fixaddress(account))) {
                // invalid addr
                console.log("INVALID ADDR. 400")
                return res.status(400).json({
                    msg: "invalid address."
                })
            }
            startTransfer(ip, account, token, amount, network).then((r) => {
                // successful transaction
                console.log("transfer succeeded OK. 200")
                return res.status(200).json({
                    hash: r
                });
            }).catch(e => {
                // either tx error/ greylisted
                console.log("transfer error ERROR:500")
                console.log(e)
                return res.status(500).json({
                    err: e
                });
            })
          }
        })
        .catch(error => {
          console.log('error', error);
        });

      console.log('route faucet called, waiting for response');
    });

  return router;
}
