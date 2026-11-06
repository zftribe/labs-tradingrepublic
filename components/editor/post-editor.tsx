"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { toast } from "sonner";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { getExtensions } from "@/lib/tiptap/extensions";
import { cleanTiptapDoc } from "@/lib/tiptap/clean";
import {
  savePost,
  setPostTags,
  publishPost,
  unpublishPost,
  deletePost,
} from "@/app/dashboard/actions";
import type { DistributionAccess, Post } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Toolbar } from "./toolbar";
import { CoverCropDialog } from "./cover-crop-dialog";

type SaveState = "idle" | "saving" | "saved";

function readAccess(post: Post): DistributionAccess {
  if (post.distribution_access === "public" || post.distribution_access === "withheld") {
    return post.distribution_access;
  }
  return "unknown";
}

export function PostEditor({
  post,
  authorId,
  initialTags,
  distributionAvailable = false,
  preview = false,
}: {
  post: Post;
  authorId: string;
  initialTags: string[];
  distributionAvailable?: boolean;
  preview?: boolean;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState(post.status);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [uploading, setUploading] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Latest values, read inside the debounced save without stale closures.
  const initialTitle = post.title === "Untitled" ? "" : post.title;
  const initialExcerpt = post.excerpt ?? "";
  const title = useRef(initialTitle);
  const excerpt = useRef(initialExcerpt);
  const cover = useRef(post.cover_image_url ?? "");

  const [coverPreview, setCoverPreview] = useState(post.cover_image_url ?? "");
  const [cropState, setCropState] = useState<{ src: string | null; key: number }>(
    { src: null, key: 0 },
  );
  const [tagsValue, setTagsValue] = useState(initialTags.join(", "));
  const initialDistribution = readAccess(post);
  const distributionAccess = useRef<DistributionAccess>(initialDistribution);
  const [distributionChoice, setDistributionChoice] = useState(initialDistribution);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live editor ref so the paste/drop handlers (captured once by editorProps)
  // always reach the current editor instance.
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: getExtensions(),
    content: cleanTiptapDoc(post.content_json) as object,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "tiptap prose-tr min-h-[360px] px-4 py-4 focus:outline-none",
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              void insertImageFile(file);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = (event as DragEvent).dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const images = Array.from(files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (images.length === 0) return false;
        event.preventDefault();
        images.forEach((f) => void insertImageFile(f));
        return true;
      },
    },
    onUpdate: () => scheduleSave(),
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!editor) return false;
    if (preview) {
      setSaveState("saved");
      return true;
    }
    setSaveState("saving");
    try {
      await savePost(post.id, {
        title: title.current.trim() || "Untitled",
        excerpt: excerpt.current.trim() || null,
        cover_image_url: cover.current || null,
        // ProseMirror builds node.attrs with Object.create(null); Next's server
        // action serialization drops null-prototype objects, silently losing
        // every media node's src. Round-trip to plain objects first.
        content_json: JSON.parse(JSON.stringify(editor.getJSON())),
        ...(distributionAvailable
          ? { distribution_access: distributionAccess.current }
          : {}),
      });
      setSaveState("saved");
      return true;
    } catch {
      setSaveState("idle");
      toast.error("Couldn't save changes");
      return false;
    }
  }, [distributionAvailable, editor, post.id, preview]);

  const scheduleSave = useCallback(() => {
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, 1200);
  }, [doSave]);

  async function uploadFile(file: File): Promise<string> {
    if (preview) {
      throw new Error("preview");
    }
    const supabase = createClient();
    const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
    const path = `${authorId}/${post.id}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from("post-media")
      .upload(path, file, { cacheControl: "3600", upsert: false });
    if (error) throw error;
    return supabase.storage.from("post-media").getPublicUrl(path).data
      .publicUrl;
  }

  // Upload a File and insert it at the cursor — shared by the toolbar button,
  // paste, and drag-and-drop.
  async function insertImageFile(file: File) {
    const ed = editorRef.current;
    if (!ed) return;
    if (preview) {
      toast.info("Uploads are disabled in preview mode.");
      return;
    }
    setUploading(true);
    try {
      const url = await uploadFile(file);
      ed.chain().focus().setImage({ src: url, alt: file.name }).run();
    } catch {
      toast.error("Image upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleInlineImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void insertImageFile(file);
  }

  function openCropper(src: string) {
    setCropState((s) => ({ src, key: s.key + 1 }));
  }
  function closeCropper() {
    setCropState((s) => ({ ...s, src: null }));
  }

  // New cover from a file picker.
  function handleCover(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (preview) {
      toast.info("Uploads are disabled in preview mode.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => openCropper(reader.result as string);
    reader.readAsDataURL(file);
  }

  // Re-crop the current cover. Fetch it to a data URL so the crop canvas is
  // never tainted (Supabase storage allows CORS).
  async function handleAdjustCover() {
    if (preview) {
      toast.info("Uploads are disabled in preview mode.");
      return;
    }
    if (!cover.current) return;
    try {
      const res = await fetch(cover.current);
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onload = () => openCropper(reader.result as string);
      reader.readAsDataURL(blob);
    } catch {
      toast.error("Couldn't load cover for editing");
    }
  }

  async function handleCroppedCover(blob: Blob) {
    closeCropper();
    setUploading(true);
    try {
      const file = new File([blob], "cover.jpg", { type: "image/jpeg" });
      const url = await uploadFile(file);
      cover.current = url;
      setCoverPreview(url);
      scheduleSave();
    } catch {
      toast.error("Cover upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function saveTags() {
    if (preview) return;
    const names = tagsValue
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await setPostTags(post.id, names);
    } catch {
      toast.error("Couldn't save tags");
    }
  }

  async function handlePublish() {
    if (preview) {
      setStatus("published");
      toast.success("Published (preview — nothing is saved)");
      return;
    }
    setPublishing(true);
    try {
      const wasPublished = status === "published";
      // Don't publish stale content if the save failed.
      const saved = await doSave();
      if (!saved) {
        toast.error("Couldn't save — fix that before publishing.");
        return;
      }
      await saveTags();
      const result = await publishPost(
        post.id,
        distributionAvailable
          ? { distribution_access: distributionAccess.current }
          : undefined,
      );
      setStatus("published");
      toast.success(
        wasPublished
          ? "Changes are live"
          : result.teaser === "queued_unconfirmed"
            ? "Published. A public teaser is queued and not confirmed delivered."
            : result.teaser === "not_configured"
              ? "Published. Public teaser mirroring is not configured, so nothing was delivered."
              : result.teaser === "not_queued"
                ? "Published. The public teaser could not be queued."
                : "Published",
      );
      router.refresh();
    } catch {
      toast.error("Couldn't publish");
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    if (preview) {
      setStatus("draft");
      toast.success("Moved back to draft (preview)");
      return;
    }
    setPublishing(true);
    try {
      await unpublishPost(post.id);
      setStatus("draft");
      toast.success("Moved back to draft");
      router.refresh();
    } catch {
      toast.error("Couldn't unpublish");
    } finally {
      setPublishing(false);
    }
  }

  async function handleDelete() {
    if (preview) {
      toast.info("Delete is disabled in preview mode.");
      return;
    }
    if (!window.confirm("Delete this post? This cannot be undone.")) return;
    try {
      await deletePost(post.id);
    } catch {
      toast.error("Couldn't delete");
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      {/* Top bar */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge variant={status === "published" ? "default" : "secondary"}>
            {status === "published" ? "Published" : "Draft"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {status === "published" && (
            <Button asChild variant="ghost" size="sm">
              <a href={`/posts/${post.slug}`} target="_blank" rel="noreferrer">
                View <ExternalLink className="ml-1 h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          {status === "published" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleUnpublish}
              disabled={publishing}
            >
              Unpublish
            </Button>
          )}
          <Button size="sm" onClick={handlePublish} disabled={publishing}>
            {publishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : status === "published" ? (
              "Update"
            ) : (
              "Publish"
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            title="Delete post"
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Cover */}
      <div className="mb-4">
        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleCover}
        />
        {coverPreview ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={coverPreview}
              alt="Cover"
              className="aspect-[2/1] w-full rounded-xl object-cover"
            />
            <div className="absolute right-3 top-3 flex gap-2">
              <Button variant="secondary" size="sm" onClick={handleAdjustCover}>
                Adjust
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => coverInputRef.current?.click()}
              >
                Replace
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  cover.current = "";
                  setCoverPreview("");
                  scheduleSave();
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => coverInputRef.current?.click()}
            className="flex aspect-[3/1] w-full cursor-pointer items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:bg-accent"
          >
            {uploading ? "Uploading…" : "Add a cover image"}
          </button>
        )}
      </div>

      {/* Title */}
      <textarea
        defaultValue={initialTitle}
        onChange={(e) => {
          title.current = e.target.value;
          scheduleSave();
        }}
        placeholder="Post title"
        rows={1}
        className="mb-3 w-full resize-none bg-transparent font-display text-3xl font-extrabold tracking-tight outline-none placeholder:text-muted-foreground/50"
      />

      {/* Editor */}
      <div className="rounded-xl border border-border bg-card">
        <Toolbar
          editor={editor}
          onPickImage={() => fileInputRef.current?.click()}
          uploading={uploading}
        />
        <EditorContent editor={editor} />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleInlineImage}
        />
      </div>

      {/* Meta */}
      <div className="mt-8 grid gap-5">
        <div className="grid gap-2">
          <Label htmlFor="excerpt">Excerpt</Label>
          <Textarea
            id="excerpt"
            defaultValue={initialExcerpt}
            onChange={(e) => {
              excerpt.current = e.target.value;
              scheduleSave();
            }}
            placeholder="A short summary shown on the home page and social cards."
            rows={2}
          />
        </div>
        {distributionAvailable && (
          <div className="grid gap-2">
            <Label htmlFor="distribution-access">Public teaser</Label>
            <select
              id="distribution-access"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              value={distributionChoice}
              onChange={(e) => {
                const value = e.target.value as DistributionAccess;
                distributionAccess.current = value;
                setDistributionChoice(value);
                scheduleSave();
              }}
            >
              <option value="unknown">Not classified — do not mirror</option>
              <option value="public">Allow a public teaser when this draft is published</option>
              <option value="withheld">Do not redistribute</option>
            </select>
            <p className="text-xs text-muted-foreground">
              This site has no membership or paywall. Publishing already makes
              an article public here. This choice only controls whether a short
              public teaser may be handed to the downstream research bot the
              first time this draft is published. It does not create paid or
              members-only access. Unclassified articles are not mirrored.
              Changing this after publication does not send a new teaser, and a
              teaser that was already handed off cannot be recalled from here.
            </p>
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor="tags">Tags</Label>
          <Input
            id="tags"
            value={tagsValue}
            onChange={(e) => setTagsValue(e.target.value)}
            onBlur={saveTags}
            placeholder="markets, research, macro"
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated, up to 8.
          </p>
        </div>
      </div>

      <CoverCropDialog
        key={cropState.key}
        src={cropState.src}
        onCancel={closeCropper}
        onCropped={handleCroppedCover}
      />
    </div>
  );
}
