"use client";

import TopicCard from "@/components/TopicCard";
import { useLanguage } from "@/i18n/LanguageContext";
import { useEffect, useState } from "react";
import { getTopics } from "@/lib/api";
import { TopicSummary } from "@/types/quiz";

export default function Home() {
  const { t } = useLanguage();
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await getTopics();
        if (!active) {
          return;
        }
        setTopics(data);
      } catch (err) {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load topics");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flex-1">
      <div className="mx-auto max-w-5xl px-4 py-14">
        <div className="mb-10 text-center">
          <p className="mb-3 inline-flex rounded-full border border-cyan-200 bg-cyan-50 px-4 py-1 text-xs font-bold uppercase tracking-widest text-cyan-700 dark:border-cyan-700 dark:bg-slate-900 dark:text-cyan-300">
            Quiz Arena
          </p>
          <h1 className="text-4xl font-black tracking-tight text-slate-900 dark:text-slate-100 sm:text-5xl">
            {t.homeHeading}
          </h1>
          <p className="mt-3 text-slate-600 dark:text-slate-300">
            {t.homeSubheading}
          </p>
        </div>

        {loading ? (
          <p className="text-center text-slate-500 dark:text-slate-300">
            {t.loadingTopics}
          </p>
        ) : error ? (
          <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-200">
            {t.couldNotLoadTopics} {error}
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {topics.map((topic) => (
              <TopicCard key={topic.id} topic={topic} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
