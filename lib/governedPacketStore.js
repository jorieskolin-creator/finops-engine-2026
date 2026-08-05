const entries = new Map();
const MAX = 200;
let clock = () => Date.now();
export function cleanupPackets() { const n=clock(); for (const [id,e] of entries) if (Date.parse(e.expires_at) <= n) entries.delete(id); while(entries.size>MAX) entries.delete(entries.keys().next().value); }
export function storeApprovedPacket(packet) { cleanupPackets(); if(entries.has(packet.packet_id)) throw new Error('PACKET_ID_COLLISION'); entries.set(packet.packet_id, packet); cleanupPackets(); }
export function claimApprovedPacket(id) { cleanupPackets(); const packet=entries.get(id); if (!packet) return null; entries.delete(id); return packet; }
export function resetPacketStoreForTests() { entries.clear(); clock=()=>Date.now(); }
export function setPacketStoreClockForTests(fn) { clock=fn; }
export function packetStoreSizeForTests() { cleanupPackets(); return entries.size; }
