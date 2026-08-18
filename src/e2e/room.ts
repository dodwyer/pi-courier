export interface JoinedRoomMembersClient {
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
}

export function requireExactDirectMembers(members: string[], driverUserId: string, botUserId: string): void {
  const actual = [...new Set(members)].sort();
  const expected = [driverUserId, botUserId].sort();
  if (actual.length !== expected.length || actual.some((member, index) => member !== expected[index])) {
    throw new Error(`Canary room must contain only ${driverUserId} and ${botUserId}; joined members: ${actual.join(", ")}`);
  }
}

export async function waitForMember(
  client: JoinedRoomMembersClient,
  roomId: string,
  userId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const members = await client.getJoinedRoomMembers(roomId);
    if (members.includes(userId)) return;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${userId} to join canary room ${roomId}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
