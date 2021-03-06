import {ConfDTO} from "../dto/ConfDTO"
import * as stream from "stream"
import {DBPeer} from "../dal/sqliteDAL/PeerDAL"
import {BlockDTO} from "../dto/BlockDTO"
import {RevocationDTO} from "../dto/RevocationDTO"
import {IdentityDTO} from "../dto/IdentityDTO"
import {CertificationDTO} from "../dto/CertificationDTO"
import {MembershipDTO} from "../dto/MembershipDTO"
import {TransactionDTO} from "../dto/TransactionDTO"
import {PeerDTO} from "../dto/PeerDTO"

const request = require('request');
const constants = require('../../lib/constants');
const logger  = require('../logger').NewLogger('multicaster');

const WITH_ISOLATION = true;

export class Multicaster extends stream.Transform {

  constructor(private conf:ConfDTO|null = null, private timeout:number = 0) {

    super({ objectMode: true })

    this.on('identity',    (data:any, peers:DBPeer[]) => this.idtyForward(data, peers))
    this.on('cert',        (data:any, peers:DBPeer[]) => this.certForward(data, peers))
    this.on('revocation',  (data:any, peers:DBPeer[]) => this.revocationForward(data, peers))
    this.on('block',       (data:any, peers:DBPeer[]) => this.blockForward(data, peers))
    this.on('transaction', (data:any, peers:DBPeer[]) => this.txForward(data, peers))
    this.on('peer',        (data:any, peers:DBPeer[]) => this.peerForward(data, peers))
    this.on('membership',  (data:any, peers:DBPeer[]) => this.msForward(data, peers))
  }

  async blockForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      transform: (b:any) => BlockDTO.fromJSONObject(b),
      type: 'Block',
      uri: '/blockchain/block',
      getObj: (block:any) => {
        return {
          "block": block.getRawSigned()
        };
      },
      getDocID: (block:any) => 'block#' + block.number
    })(doc, peers)
  }

  async idtyForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      transform: (obj:any) => IdentityDTO.fromJSONObject(obj),
      type: 'Identity',
      uri: '/wot/add',
      getObj: (idty:IdentityDTO) => {
        return {
          "identity": idty.getRawSigned()
        };
      },
      getDocID: (idty:any) => 'with ' + (idty.certs || []).length + ' certs'
    })(doc, peers)
  }

  async certForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      transform: (obj:any) => CertificationDTO.fromJSONObject(obj),
      type: 'Cert',
      uri: '/wot/certify',
      getObj: (cert:CertificationDTO) => {
        return {
          "cert": cert.getRawSigned()
        };
      },
      getDocID: (idty:any) => 'with ' + (idty.certs || []).length + ' certs'
    })(doc, peers)
  }

  async revocationForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      transform: (json:any) => RevocationDTO.fromJSONObject(json),
      type: 'Revocation',
      uri: '/wot/revoke',
      getObj: (revocation:RevocationDTO) => {
        return {
          "revocation": revocation.getRaw()
        };
      }
    })(doc, peers)
  }

  async txForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      transform: (obj:any) => TransactionDTO.fromJSONObject(obj),
      type: 'Transaction',
      uri: '/tx/process',
      getObj: (transaction:TransactionDTO) => {
        return {
          "transaction": transaction.getRaw(),
          "signature": transaction.signature
        };
      }
    })(doc, peers)
  }

  async peerForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      type: 'Peer',
      uri: '/network/peering/peers',
      transform: (obj:any) => PeerDTO.fromJSONObject(obj),
      getObj: (peering:PeerDTO) => {
        return {
          peer: peering.getRawSigned()
        };
      },
      getDocID: (doc:PeerDTO) => doc.keyID() + '#' + doc.blockNumber(),
      withIsolation: WITH_ISOLATION,
      onError: (resJSON:{ peer:{ block:string, endpoints:string[] }}, peering:any, to:any) => {
        const sentPeer = PeerDTO.fromJSONObject(peering)
        if (PeerDTO.blockNumber(resJSON.peer.block) > sentPeer.blockNumber()) {
          this.push({ outdated: true, peer: resJSON.peer });
          logger.warn('Outdated peer document (%s) sent to %s', sentPeer.keyID() + '#' + sentPeer.blockNumber(), to);
        }
        return Promise.resolve();
      }
    })(doc, peers)
  }

  async msForward(doc:any, peers:DBPeer[]) {
    return this.forward({
      transform: (obj:any) => MembershipDTO.fromJSONObject(obj),
      type: 'Membership',
      uri: '/blockchain/membership',
      getObj: (membership:MembershipDTO) => {
        return {
          "membership": membership.getRaw(),
          "signature": membership.signature
        };
      }
    })(doc, peers)
  }

  _write(obj:any, enc:any, done:any) {
    this.emit(obj.type, obj.obj, obj.peers)
    done()
  }

  sendBlock(toPeer:any, block:any) {
    return this.blockForward(block, [toPeer])
  }

  sendPeering(toPeer:any, peer:any) {
    return this.peerForward(peer, [toPeer])
  }

  forward(params:any) {
    return async (doc:any, peers:DBPeer[]) => {
      try {
        if(!params.withIsolation || !(this.conf && this.conf.isolate)) {
          let theDoc = params.transform ? params.transform(doc) : doc;
          logger.debug('--> new %s to be sent to %s peer(s)', params.type, peers.length);
          if (params.getDocID) {
            logger.info('POST %s %s', params.type, params.getDocID(theDoc));
          } else {
            logger.info('POST %s', params.type);
          }
          // Parallel treatment for superfast propagation
          await Promise.all(peers.map(async (p) => {
            let peer = PeerDTO.fromJSONObject(p)
            const namedURL = peer.getNamedURL();
            logger.debug(' `--> to peer %s [%s] (%s)', peer.keyID(), peer.member ? 'member' : '------', namedURL);
            try {
              await this.post(peer, params.uri, params.getObj(theDoc))
            } catch (e) {
              if (params.onError) {
                try {
                  const json = JSON.parse(e.body);
                  await params.onError(json, doc, namedURL)
                } catch (ex) {
                  logger.warn('Could not reach %s', namedURL);
                }
              }
            }
          }))
        } else {
          logger.debug('[ISOLATE] Prevent --> new Peer to be sent to %s peer(s)', peers.length);
        }
      } catch (err) {
        logger.error(err);
      }
    }
  }

  post(peer:any, uri:string, data:any) {
    if (!peer.isReachable()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const postReq = request.post({
        "uri": protocol(peer.getPort()) + '://' + peer.getURL() + uri,
        "timeout": this.timeout || constants.NETWORK.DEFAULT_TIMEOUT
      }, (err:any, res:any) => {
        if (err) {
          this.push({ unreachable: true, peer: { pubkey: peer.pubkey }});
          logger.warn(err.message || err);
        }
        if (res && res.statusCode != 200) {
          return reject(res);
        }
        resolve(res);
      })
      postReq.form(data);
    });
  }
}

function protocol(port:number) {
  return port == 443 ? 'https' : 'http';
}
