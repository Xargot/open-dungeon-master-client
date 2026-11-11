package com.opendungeonmaster.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.tukaani.xz.LZMA2Options;
import org.tukaani.xz.XZOutputStream;

/** The bundled payload as the build packs it: a stored zip inside one xz stream. */
public class PayloadUnpackTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static void stored(ZipOutputStream zip, String name, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        ZipEntry entry = new ZipEntry(name);
        entry.setMethod(ZipEntry.STORED);
        entry.setSize(bytes.length);
        CRC32 crc = new CRC32();
        crc.update(bytes);
        entry.setCrc(crc.getValue());
        zip.putNextEntry(entry);
        zip.write(bytes);
        zip.closeEntry();
    }

    private static byte[] packed(String[][] files) throws IOException {
        ByteArrayOutputStream zipped = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(zipped)) {
            ZipEntry folder = new ZipEntry(".next/");
            folder.setMethod(ZipEntry.STORED);
            folder.setSize(0);
            folder.setCrc(0);
            zip.putNextEntry(folder);
            zip.closeEntry();
            for (String[] file : files) stored(zip, file[0], file[1]);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        LZMA2Options options = new LZMA2Options(9);
        options.setDictSize(1 << 20);
        try (XZOutputStream xz = new XZOutputStream(out, options)) {
            xz.write(zipped.toByteArray());
        }
        return out.toByteArray();
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void unpacksEveryFileAndWritesTheMarkerLast() throws IOException {
        File target = tmp.newFolder("server.new");
        byte[] payload = packed(new String[][] {
            {PayloadStore.MARKER, "{\"builtAt\":\"x\"}"},
            {".next/server/chunks/a.js", "a"},
            {"server.js", "s"},
        });
        WorldEnvironment.unpackPayload(new ByteArrayInputStream(payload), target);
        assertEquals("a", read(new File(target, ".next/server/chunks/a.js")));
        assertEquals("s", read(new File(target, "server.js")));
        assertTrue(new File(target, ".next").isDirectory());
        assertTrue(PayloadStore.hasMarker(target));
    }

    @Test
    public void aCutShortPayloadLeavesNoMarker() throws IOException {
        File target = tmp.newFolder("server.new");
        byte[] payload = packed(new String[][] {
            {"server.js", "s"},
            {PayloadStore.MARKER, "{\"builtAt\":\"x\"}"},
        });
        byte[] cut = new byte[payload.length / 2];
        System.arraycopy(payload, 0, cut, 0, cut.length);
        try {
            WorldEnvironment.unpackPayload(new ByteArrayInputStream(cut), target);
            fail("a truncated payload unpacked");
        } catch (IOException expected) {
            // The xz stream ends early: the tree is not marked complete.
        }
        assertFalse(PayloadStore.hasMarker(target));
    }

    @Test
    public void refusesAnEntryOutsideTheTarget() throws IOException {
        File target = tmp.newFolder("server.new");
        byte[] payload = packed(new String[][] {{"../escape.js", "x"}, {PayloadStore.MARKER, "{}"}});
        try {
            WorldEnvironment.unpackPayload(new ByteArrayInputStream(payload), target);
            fail("an entry outside the target unpacked");
        } catch (IOException expected) {
            // Bad zip entry.
        }
        assertFalse(new File(target.getParentFile(), "escape.js").exists());
    }
}
