package com.opendungeonmaster.app;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/**
 * Where the unpacked server lives and how a new payload replaces it without
 * ever holding the only copy of player data in a folder that is about to be
 * deleted. Layout under the app's files dir:
 *
 * <pre>
 *   server/       the live tree; odm-payload.json inside it is the commit marker
 *   server.new    a payload being unpacked; complete once its marker exists
 *   server.old    the previous tree during the swap, deleted last
 *   server.keep   what the older copy-based upgrade used; merged back if found
 * </pre>
 *
 * An upgrade unpacks into server.new (marker written last), moves the
 * PRESERVED folders across with rename (same filesystem, so no copy),
 * renames server to server.old and server.new to server, then deletes
 * server.old. {@link #recover()} runs before every start and finishes or
 * unwinds whatever an earlier run left behind. Pure java.io so it can be
 * unit tested on a temp directory.
 */
final class PayloadStore {

    static final String MARKER = "odm-payload.json";

    /**
     * Player-made data inside the server tree that must survive a payload upgrade:
     * the same list as PRESERVED in the desktop's src/main/local-server.ts, which
     * says why each folder is here. data/ holds the installed world packs.
     */
    static final String[] PRESERVED = {
        "public/uploads",
        "public/generated",
        "public/generated-audio",
        "public/ambience",
        "models",
        "data",
    };

    /** Writes a whole payload into a directory, with the marker file last. */
    interface Unpacker {
        void unpackInto(File dir) throws IOException;
    }

    private final File server;
    private final File fresh;
    private final File old;
    private final File keep;

    PayloadStore(File filesDir) {
        server = new File(filesDir, "server");
        fresh = new File(filesDir, "server.new");
        old = new File(filesDir, "server.old");
        keep = new File(filesDir, "server.keep");
    }

    File serverDir() {
        return server;
    }

    static boolean hasMarker(File dir) {
        return new File(dir, MARKER).isFile();
    }

    /** Writes the marker through a temp name so a torn write never passes for a finished unpack. */
    static void writeMarker(File dir, byte[] bytes) throws IOException {
        File part = new File(dir, MARKER + ".part");
        Files.write(part.toPath(), bytes);
        Files.move(part.toPath(), new File(dir, MARKER).toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    /**
     * Puts the tree back into a consistent shape after an interrupted
     * upgrade. Cheap when there is nothing to do, so it runs every start.
     * Order matters: a leftover server.old or server.keep is folded into
     * server/ first, so that a complete server.new then swaps in over a
     * tree that holds everything the player made.
     */
    void recover() throws IOException {
        if (keep.isDirectory()) {
            // The copy-based upgrade died between deleting server/ and copying back.
            if (server.isDirectory()) movePreserved(keep, server, true);
            else rename(keep, server);
            deleteTree(keep);
        }
        if (old.isDirectory()) {
            // The swap got past renaming server/ aside. Anything preserved still
            // inside it was never moved out, so it wins over the new tree.
            if (server.isDirectory()) movePreserved(old, server, true);
            else rename(old, server);
            deleteTree(old);
        }
        if (fresh.isDirectory()) {
            if (hasMarker(fresh)) {
                // Unpack finished; the moves and the swap may be part way through.
                if (server.isDirectory()) {
                    movePreserved(server, fresh, true);
                    swap();
                } else {
                    rename(fresh, server);
                }
            } else {
                // Unpack was interrupted before the marker, so nothing of the
                // player's was moved in yet. Fill any gap in server/ from it
                // rather than trust that, then drop it.
                if (server.isDirectory()) movePreserved(fresh, server, false);
                deleteTree(fresh);
            }
        }
    }

    /** Replaces the live tree with a freshly unpacked payload, keeping the PRESERVED folders. */
    void upgrade(Unpacker unpacker) throws IOException {
        recover();
        if (!fresh.mkdirs()) throw new IOException("Could not create " + fresh);
        try {
            unpacker.unpackInto(fresh);
            if (!hasMarker(fresh)) throw new IOException("The payload has no " + MARKER);
        } catch (IOException e) {
            // Nothing of the player's has moved yet, so the half-written tree can go.
            deleteTree(fresh);
            throw e;
        }
        if (server.isDirectory()) {
            movePreserved(server, fresh, true);
            swap();
        } else {
            rename(fresh, server);
        }
    }

    private void swap() throws IOException {
        rename(server, old);
        rename(fresh, server);
        deleteTree(old);
    }

    private static void movePreserved(File from, File to, boolean overwrite) throws IOException {
        for (String rel : PRESERVED) {
            File source = new File(from, rel);
            if (source.exists()) moveTree(source, new File(to, rel), overwrite);
        }
    }

    /**
     * Moves a file or directory by rename when it can, copying only when the
     * rename fails, and merges into whatever already exists at the target.
     * With overwrite false, files already at the target are left alone.
     */
    static void moveTree(File from, File to, boolean overwrite) throws IOException {
        if (!to.exists()) {
            File parent = to.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
            if (from.renameTo(to)) return;
            copyTree(from, to);
            deleteTree(from);
            return;
        }
        if (from.isDirectory() && to.isDirectory()) {
            File[] children = from.listFiles();
            if (children != null) for (File child : children) moveTree(child, new File(to, child.getName()), overwrite);
            //noinspection ResultOfMethodCallIgnored
            from.delete();
            return;
        }
        if (!overwrite) return;
        deleteTree(to);
        if (from.renameTo(to)) return;
        copyTree(from, to);
        deleteTree(from);
    }

    private static void rename(File from, File to) throws IOException {
        if (!from.renameTo(to)) throw new IOException("Could not move " + from + " to " + to);
    }

    static void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    static void copyTree(File from, File to) throws IOException {
        if (from.isDirectory()) {
            if (!to.isDirectory() && !to.mkdirs()) throw new IOException("mkdir " + to);
            File[] children = from.listFiles();
            if (children != null) for (File child : children) copyTree(child, new File(to, child.getName()));
        } else {
            File parent = to.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
            Files.copy(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
