// Hand-maintained to match supabase/migrations/0001_init.sql.
// Regenerate with `supabase gen types typescript` once the project is linked.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole = "admin" | "author";
export type PostStatus = "draft" | "published";
export type DistributionAccess = "unknown" | "public" | "withheld";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          display_name: string | null;
          bio: string | null;
          avatar_url: string | null;
          twitter: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          role?: UserRole;
          display_name?: string | null;
          bio?: string | null;
          avatar_url?: string | null;
          twitter?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          role?: UserRole;
          display_name?: string | null;
          bio?: string | null;
          avatar_url?: string | null;
          twitter?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      posts: {
        Row: {
          id: string;
          author_id: string;
          title: string;
          slug: string;
          excerpt: string | null;
          cover_image_url: string | null;
          content_json: Json;
          content_html: string | null;
          status: PostStatus;
          published_at: string | null;
          distribution_access?: DistributionAccess;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          author_id: string;
          title: string;
          slug: string;
          excerpt?: string | null;
          cover_image_url?: string | null;
          content_json?: Json;
          content_html?: string | null;
          status?: PostStatus;
          published_at?: string | null;
          distribution_access?: DistributionAccess;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          author_id?: string;
          title?: string;
          slug?: string;
          excerpt?: string | null;
          cover_image_url?: string | null;
          content_json?: Json;
          content_html?: string | null;
          status?: PostStatus;
          published_at?: string | null;
          distribution_access?: DistributionAccess;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      distribution_outbox: {
        Row: {
          id: string;
          post_id: string;
          publication_id: string | null;
          type: string;
          issued_at: string;
          status: string;
          terminal_result: string | null;
          origin: string;
          claim_token: string | null;
          claimed_at: string | null;
          attempt_count: number;
          last_error: string | null;
          snapshot_status: string;
          snapshot_access: string;
          snapshot_published_at: string | null;
          snapshot_title: string;
          snapshot_slug: string;
          snapshot_excerpt: string | null;
          snapshot_cover: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          post_id: string;
          publication_id?: string | null;
          type: string;
          issued_at: string;
          status?: string;
          terminal_result?: string | null;
          origin?: string;
          claim_token?: string | null;
          claimed_at?: string | null;
          attempt_count?: number;
          last_error?: string | null;
          snapshot_status: string;
          snapshot_access: string;
          snapshot_published_at?: string | null;
          snapshot_title: string;
          snapshot_slug: string;
          snapshot_excerpt?: string | null;
          snapshot_cover?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          post_id?: string;
          publication_id?: string | null;
          type?: string;
          issued_at?: string;
          status?: string;
          terminal_result?: string | null;
          origin?: string;
          claim_token?: string | null;
          claimed_at?: string | null;
          attempt_count?: number;
          last_error?: string | null;
          snapshot_status?: string;
          snapshot_access?: string;
          snapshot_published_at?: string | null;
          snapshot_title?: string;
          snapshot_slug?: string;
          snapshot_excerpt?: string | null;
          snapshot_cover?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tags: {
        Row: { id: string; name: string; slug: string };
        Insert: { id?: string; name: string; slug: string };
        Update: { id?: string; name?: string; slug?: string };
        Relationships: [];
      };
      post_tags: {
        Row: { post_id: string; tag_id: string };
        Insert: { post_id: string; tag_id: string };
        Update: { post_id?: string; tag_id?: string };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_admin: { Args: Record<string, never>; Returns: boolean };
      next_teaser_issued_at: { Args: Record<string, never>; Returns: string };
      distribution_eligibility: {
        Args: { p_id: string };
        Returns: { status: string; access: string; issued_at: string }[];
      };
    };
    Enums: {
      user_role: UserRole;
      post_status: PostStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Post = Database["public"]["Tables"]["posts"]["Row"];
export type Tag = Database["public"]["Tables"]["tags"]["Row"];
