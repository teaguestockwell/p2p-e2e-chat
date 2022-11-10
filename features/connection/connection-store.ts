import create from "zustand";
import type { Peer, DataConnection, MediaConnection } from "peerjs";
import humanid from "human-id";
import deb from "lodash/debounce";

export type MsgEvent = {
  senderId: string;
  createdAt: number;
  msg: string;
};

export type ConnectionState = {
  selfId: string;
  peerId: string;
  msg: string;
  msgs: MsgEvent[];
  status:
    | "enter-self-id"
    | "connecting-self"
    | "awaiting-peer"
    | "connecting-peer"
    | "connected"
    | "calling-peer"
    | "call-connected";
  isPeerTyping: boolean;
};

const getInitState = (): ConnectionState => ({
  selfId: humanid(" ").toLowerCase(),
  peerId: "",
  msg: "",
  msgs: [],
  status: "enter-self-id",
  isPeerTyping: false,
});

export type ConnectionActions = {
  setSelfId: (e: { target: { value: string } }) => void;
  setPeerId: (e: { target: { value: string } }) => void;
  setMsg: (e: { target: { value: string } }) => void;
  publishToBroker: (onOpen?: () => unknown) => Promise<void>;
  connectPeer: () => void;
  emit: () => void;
  receive: (e: MsgEvent) => void;
  callPeer: () => void;
  endCall: () => void;
  dispose: () => void;
  backToPeerSelection: () => void;
  autoConnectToPeer: (peerIs: string) => void;
};

let _peer: Peer | undefined;
let _dataCon: DataConnection | undefined;
let _selfMediaStream: MediaStream | undefined;
let _peerMediaStream: MediaStream | undefined;
let _peerMediaCon: MediaConnection | undefined;

const getPeerJs = async () => {
  const PeerJs = (await import("peerjs")).default;
  return PeerJs;
};

const getPeer = () => {
  if (!_peer) {
    throw new Error(
      "peer not initialized, your public id has not been published to the connection broker"
    );
  }
  return _peer;
};

const getDataConn = () => {
  if (!_dataCon) {
    throw new Error(
      "data connection not initialized, you are not connected to a peer"
    );
  }
  return _dataCon;
};

const createSelfMediaStream = async () => {
  try {
    _selfMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    return _selfMediaStream;
  } catch (e) {
    alert("cant find audio video device");
    return;
  }
};

export const getSelfMediaStream = () => {
  if (!_selfMediaStream) {
    throw new Error(
      "media stream not initialized, you are not in a call with a peer"
    );
  }
  return _selfMediaStream;
};

export const getPeerMediaStream = () => {
  if (!_peerMediaStream) {
    throw new Error(
      "media stream not initialized, you are not in a call with a peer"
    );
  }
  return _peerMediaStream;
};

const disposeVideo = () => {
  _selfMediaStream?.getTracks().forEach((t) => t.stop());
  _peerMediaStream?.getTracks().forEach((t) => t.stop());
  _peerMediaCon?.close();
};

const disposeSession = () => {
  disposeVideo();
  connectionStore.getState().backToPeerSelection();
};

const onPing = deb(disposeSession, 5000);

let stopPing: undefined | (() => void);
const startPinging = () => {
  stopPing?.();
  const i = setInterval(() => {
    _dataCon?.send(2);
  }, 3000);
  stopPing = () => {
    clearInterval(i);
  };
};

const onPeerType = deb(() => {
  connectionStore.setState({ isPeerTyping: false });
}, 5000);

const omitted = new Set("1234567890-=[];'\\,./`!@#$%^&*()_+|\":?><~".split(""));

const cleanId = (s: string) => {
  return s
    .toLowerCase()
    .split("")
    .map((c) => (omitted.has(c) ? "" : c))
    .join("")
    .replace(/\s+/g, " ");
};

export const connectionStore = create<ConnectionState & ConnectionActions>(
  (set, get) => ({
    ...getInitState(),
    autoConnectToPeer: (peerId) => {
      set({
        ...getInitState(),
        peerId,
      });

      get().publishToBroker(() => {
        get().connectPeer();
      });
    },
    dispose: () => {
      get().endCall();
      set(getInitState());
    },
    backToPeerSelection: () => {
      stopPing?.();
      disposeVideo();
      _dataCon?.close();
      set({ peerId: "", status: "awaiting-peer", msg: "", msgs: [] });
    },
    setSelfId: (e) => set({ selfId: cleanId(e.target.value) }),
    setPeerId: (e) => set({ peerId: cleanId(e.target.value) }),
    setMsg: (e) => {
      set({ msg: e.target.value });
      _dataCon?.send(1);
    },
    publishToBroker: async (onOpen) => {
      const selfId = get().selfId.trim();
      set({ selfId });
      if (!selfId) {
        return;
      }

      set({ status: "connecting-self" });

      const PeerJs = await getPeerJs();
      _peer = new PeerJs(selfId);

      const callEnder = () => {
        if (document.visibilityState === "hidden") {
          get().endCall();
          get().backToPeerSelection();
        }
      };

      window.addEventListener("visibilitychange", callEnder);
      window.addEventListener("pagehide", callEnder);

      _peer.on("disconnected", get().backToPeerSelection);
      _peer.on("close", get().backToPeerSelection);
      _peer.on("error", get().backToPeerSelection);
      _peer.on("open", () => {
        set({ status: "awaiting-peer" });
        onOpen?.();
      });

      _peer.on("connection", (c) => {
        startPinging();
        _dataCon = c;
        _dataCon.on("close", get().backToPeerSelection);
        _dataCon.on("error", get().backToPeerSelection);
        _dataCon.on("iceStateChanged", (s) => {
          if (s === "closed" || s === "failed") {
            get().backToPeerSelection();
          }
        });
        _dataCon.on("data", (data) => {
          get().receive(data as any);
        });
        set({ status: "connected", peerId: c.peer });
      });
      _peer.on("call", (call) => {
        const { peerId } = get();
        if (!peerId) {
          throw new Error("cant connect to peer without id");
        }

        _peerMediaCon = call;
        _peerMediaCon.on("error", get().endCall);
        _peerMediaCon.on("close", get().endCall);
        _peerMediaCon.on("iceStateChanged", (s) => {
          if (s === "closed" || s === "failed") {
            get().endCall();
          }
        });

        _peerMediaCon.on("stream", (peerMediaStream) => {
          _peerMediaStream = peerMediaStream;
          set({ status: "call-connected" });
        });

        const willAnswer = confirm(`answer call from ${peerId}?`);

        if (!willAnswer) {
          get().endCall();
          return;
        }

        createSelfMediaStream().then((selfStream) => {
          if (!selfStream) {
            get().endCall();
            return;
          }

          call.answer(selfStream);
        });
      });
    },
    connectPeer: () => {
      const peerId = get().peerId.trim();
      set({ peerId });
      if (!peerId) {
        return;
      }

      set({ status: "connecting-peer" });

      _dataCon = getPeer().connect(peerId);

      _dataCon.on("open", () => {
        startPinging();
        set({ status: "connected" });
      });
      _dataCon.on("error", get().backToPeerSelection);
      _dataCon.on("close", get().backToPeerSelection);
      _dataCon.on("data", (data) => {
        get().receive(data as any);
      });
      _dataCon.on("iceStateChanged", (s) => {
        if (s === "closed" || s === "failed") {
          get().backToPeerSelection();
        }
      });
    },
    callPeer: () => {
      const { peerId } = get();
      if (!peerId) {
        throw new Error("cant connect to peer without id");
      }

      set({ status: "calling-peer" });

      createSelfMediaStream().then((selfStream) => {
        if (!selfStream) {
          get().endCall();
          return;
        }

        _peerMediaCon = getPeer().call(peerId, selfStream);
        _peerMediaCon.on("error", get().endCall);
        _peerMediaCon.on("close", get().endCall);
        _peerMediaCon.on("iceStateChanged", (s) => {
          if (s === "closed" || s === "failed") {
            get().endCall();
          }
        });

        _peerMediaCon.on("stream", (peerMediaStream) => {
          _peerMediaStream = peerMediaStream;
          set({ status: "call-connected" });
        });
      });
    },
    emit: () => {
      const { msg, selfId, peerId, receive } = get();
      const e: MsgEvent = {
        senderId: selfId,
        createdAt: Date.now(),
        msg,
      };

      if (!msg) return;

      set((p) => ({ msg: "", msgs: [...p.msgs, e] }));
      getDataConn().send(e);
    },
    receive: (e) => {
      if (typeof e === "number") {
        if (e === 0) {
          disposeVideo();
          set({ status: "connected" });
          return;
        }
        if (e === 1) {
          connectionStore.setState({ isPeerTyping: true });
          onPeerType();
          return;
        }
        if (e === 2) {
          onPing();
          return;
        }
      }

      set((p) => ({
        msgs: [...p.msgs, e],
      }));
    },
    endCall: () => {
      disposeVideo();
      _dataCon?.send(0);
      set({ status: "connected" });
    },
  })
);

export const connectionActions = connectionStore.getState();
