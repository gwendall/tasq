import generatedDocs from "@/generated/docs.json";
import { publicCodeExamples, type PublicCodeExampleId } from "@/lib/examples";

export type DocSection = {
  title: string;
  body: string[];
  bullets?: string[];
  code?: string;
  codeTitle?: string;
  callout?: string;
};

export type DocPage = {
  slug: string;
  eyebrow: string;
  title: string;
  summary: string;
  sections: DocSection[];
};

type GeneratedDocSection = Omit<DocSection, "code" | "codeTitle"> & {
  code?: string;
  codeTitle?: string;
  codeExample?: PublicCodeExampleId;
};

type GeneratedDocPage = Omit<DocPage, "sections"> & {
  sections: GeneratedDocSection[];
};

function materializeSection(section: GeneratedDocSection): DocSection {
  const { codeExample, ...content } = section;
  if (!codeExample) return content;
  const example = publicCodeExamples[codeExample];
  if (!example) throw new Error(`Unknown public code example: ${codeExample}`);
  return { ...content, code: example.display, codeTitle: example.title };
}

export const docPages: DocPage[] = (generatedDocs.pages as GeneratedDocPage[]).map((page) => ({
  ...page,
  sections: page.sections.map(materializeSection),
}));

export function getDocPage(slug: string): DocPage | undefined {
  return docPages.find((page) => page.slug === slug);
}
