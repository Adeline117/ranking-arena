import Peer, { MediaConnection } from 'peerjs'

export type CallState = 'idle' | 'calling' | 'ringing' | 'connected'

export type CallType = 'voice' | 'video'

export interface PeerCallOptions {
  peerId: string
  onStateChange?: (state: CallState) => void
  onRemoteStream?: (stream: MediaStream) => void
  onLocalStream?: (stream: MediaStream) => void
  onError?: (error: Error) => void
  onCallEnd?: () => void
}

let peerInstance: Peer | null = null
let currentCall: MediaConnection | null = null
let localStream: MediaStream | null = null
let callTimer: ReturnType<typeof setInterval> | null = null
let callStartTime: number | null = null

export function getCallDuration(): number {
  if (!callStartTime) return 0
  return Math.floor((Date.now() - callStartTime) / 1000)
}

export function createPeer(userId: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    if (peerInstance && !peerInstance.destroyed) {
      resolve(peerInstance)
      return
    }

    // Use free PeerJS cloud server
    const peer = new Peer(`ra-${userId}`, {
      debug: 1,
    })

    peer.on('open', () => {
      peerInstance = peer
      resolve(peer)
    })

    peer.on('error', (err) => {
      reject(err)
    })
  })
}

export function getPeer(): Peer | null {
  return peerInstance
}

export async function callUser(
  targetUserId: string,
  callType: CallType,
  options: Omit<PeerCallOptions, 'peerId'>
): Promise<void> {
  const { onStateChange, onRemoteStream, onLocalStream, onError, onCallEnd } = options

  try {
    if (!peerInstance || peerInstance.destroyed) {
      throw new Error('Peer not initialized')
    }

    onStateChange?.('calling')

    const constraints: MediaStreamConstraints = {
      audio: true,
      video: callType === 'video' ? { facingMode: 'user' } : false,
    }

    localStream = await navigator.mediaDevices.getUserMedia(constraints)
    onLocalStream?.(localStream)

    const targetPeerId = `ra-${targetUserId}`
    const call = peerInstance.call(targetPeerId, localStream, {
      metadata: { callType, timestamp: Date.now() },
    })

    currentCall = call

    call.on('stream', (remoteStream) => {
      onStateChange?.('connected')
      callStartTime = Date.now()
      onRemoteStream?.(remoteStream)
    })

    call.on('close', () => {
      cleanup()
      onStateChange?.('idle')
      onCallEnd?.()
    })

    call.on('error', (err) => {
      cleanup()
      onStateChange?.('idle')
      onError?.(err)
    })
  } catch (err) {
    cleanup()
    onStateChange?.('idle')
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

export function answerCall(
  call: MediaConnection,
  options: Omit<PeerCallOptions, 'peerId'>
): void {
  const { onStateChange, onRemoteStream, onLocalStream, onError, onCallEnd } = options
  const callType = (call.metadata?.callType as CallType) || 'voice'

  const constraints: MediaStreamConstraints = {
    audio: true,
    video: callType === 'video' ? { facingMode: 'user' } : false,
  }

  navigator.mediaDevices
    .getUserMedia(constraints)
    .then((stream) => {
      localStream = stream
      onLocalStream?.(stream)
      currentCall = call

      call.answer(stream)

      call.on('stream', (remoteStream) => {
        onStateChange?.('connected')
        callStartTime = Date.now()
        onRemoteStream?.(remoteStream)
      })

      call.on('close', () => {
        cleanup()
        onStateChange?.('idle')
        onCallEnd?.()
      })

      call.on('error', (err) => {
        cleanup()
        onStateChange?.('idle')
        onError?.(err)
      })
    })
    .catch((err) => {
      onStateChange?.('idle')
      onError?.(err instanceof Error ? err : new Error(String(err)))
    })
}

export function endCall(): void {
  if (currentCall) {
    currentCall.close()
  }
  cleanup()
}

function cleanup(): void {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop())
    localStream = null
  }
  currentCall = null
  callStartTime = null
  if (callTimer) {
    clearInterval(callTimer)
    callTimer = null
  }
}

export function toggleMute(): boolean {
  if (!localStream) return false
  const audioTrack = localStream.getAudioTracks()[0]
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled
    return !audioTrack.enabled // true = muted
  }
  return false
}

export function toggleCamera(): boolean {
  if (!localStream) return false
  const videoTrack = localStream.getVideoTracks()[0]
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled
    return !videoTrack.enabled // true = camera off
  }
  return false
}

export async function switchCamera(): Promise<void> {
  if (!localStream || !currentCall) return

  const currentTrack = localStream.getVideoTracks()[0]
  if (!currentTrack) return

  const settings = currentTrack.getSettings()
  const newFacing = settings.facingMode === 'user' ? 'environment' : 'user'

  currentTrack.stop()

  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: newFacing },
  })

  const newTrack = newStream.getVideoTracks()[0]
  localStream.removeTrack(currentTrack)
  localStream.addTrack(newTrack)

  // Replace track in the peer connection
  const sender = (currentCall as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
    ?.getSenders()
    .find((s: RTCRtpSender) => s.track?.kind === 'video')
  if (sender) {
    await sender.replaceTrack(newTrack)
  }
}

export function destroyPeer(): void {
  endCall()
  if (peerInstance) {
    peerInstance.destroy()
    peerInstance = null
  }
}
