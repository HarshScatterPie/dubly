import { beforeEach, describe, expect, it } from 'vitest';
import { mongoDb } from './mongo';
import { deleteStoredFile, findStoredFile, forgetStoredFile, uploadBufferToStorage } from './mediaStore';
import { resetDatabase } from '../test/helpers';

const PATH = 'workspaces/ws-cache/projects/p1/dubbed.mp4';

// Removes the stored versions behind the cache's back, as another process (a script, a second server) would.
async function deleteFromOutside(storagePath: string): Promise<void> {
  const files = await mongoDb().collection('media.files').find({ filename: storagePath }).toArray();
  await mongoDb().collection('media.chunks').deleteMany({ files_id: { $in: files.map((f) => f._id) } });
  await mongoDb().collection('media.files').deleteMany({ filename: storagePath });
}

describe('stored file lookups', () => {
  beforeEach(resetDatabase);

  it('see an overwrite or a delete in this process straight away', async () => {
    await uploadBufferToStorage(PATH, Buffer.from('first'), 'video/mp4');
    const first = await findStoredFile(PATH);
    expect(first?.length).toBe(5);

    await uploadBufferToStorage(PATH, Buffer.from('second'), 'video/mp4');
    const second = await findStoredFile(PATH);
    expect(second?.length).toBe(6);
    expect(second?._id.equals(first!._id)).toBe(false);

    await deleteStoredFile(PATH);
    expect(await findStoredFile(PATH)).toBeNull();
  });

  it('remember a record for range requests until it is forgotten', async () => {
    await uploadBufferToStorage(PATH, Buffer.from('video'), 'video/mp4');
    const looked = await findStoredFile(PATH);
    await deleteFromOutside(PATH);
    // Still answered from memory: a seeking player does not cost a query per range request.
    expect((await findStoredFile(PATH))?._id.equals(looked!._id)).toBe(true);
    forgetStoredFile(PATH);
    expect(await findStoredFile(PATH)).toBeNull();
  });

  it('do not cache a lookup that was in flight when the path changed', async () => {
    await uploadBufferToStorage(PATH, Buffer.from('old'), 'video/mp4');
    forgetStoredFile(PATH);
    const inFlight = findStoredFile(PATH);
    // The path changes while that read is outstanding (a re-render finishing).
    forgetStoredFile(PATH);
    expect(await inFlight).not.toBeNull();
    await deleteFromOutside(PATH);
    // Had the in-flight read been cached, this would still return the version that is gone.
    expect(await findStoredFile(PATH)).toBeNull();
  });
});
