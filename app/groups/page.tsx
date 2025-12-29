"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";

type Group = {
  id: string;
  name: string;
  description: string | null;
  visibility: "open" | "apply";
};

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);

      const { data, error } = await supabase
        .from("groups")
        .select("id,name,description,visibility")
        .order("created_at", { ascending: false });

      if (error) setErr(error.message);
      else setGroups((data as Group[]) ?? []);

      setLoading(false);
    })();
  }, []);

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>Groups</h1>

      {loading && <p>Loading…</p>}
      {err && <p style={{ color: "tomato" }}>Error: {err}</p>}

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {groups.map((g) => (
          <Link
            key={g.id}
            href={`/groups/${g.id}`}
            style={{
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              padding: 14,
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontWeight: 650 }}>{g.name}</div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                {g.visibility === "open" ? "Open" : "Apply"}
              </div>
            </div>
            <div style={{ opacity: 0.8, marginTop: 6 }}>
              {g.description || "No description"}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
