---
name: rag-pipeline
description: Build a retrieval-augmented generation pipeline with grounded, cited answers
category: data-ml
---

# RAG Pipeline

Use when an LLM needs to answer over a corpus it wasn't trained on — docs, knowledge base, tickets — and answers must be grounded in retrieved sources.

1. Chunk source documents thoughtfully (by section/heading, with overlap) and keep metadata: source id, title, and offsets for citation.
2. Embed chunks and index them in a vector store; consider hybrid retrieval (vector + keyword/BM25) for better recall on names and codes.
3. At query time, retrieve top-k, optionally rerank, and assemble a context block that fits the model's window with the most relevant chunks first.
4. Prompt the model to answer only from the provided context and to cite chunk ids; instruct it to say "not found" when context is insufficient.
5. Return citations to the user and evaluate retrieval (recall@k) and answer faithfulness separately.
6. Tune chunk size, k, and reranking against an eval set rather than by feel.

## Rules
- Ground every claim in retrieved context and require citations; an ungrounded answer is a hallucination risk.
- Retrieval quality caps answer quality — debug recall before blaming the generator.
- Use hybrid search when queries contain exact tokens (ids, error codes, proper nouns) that embeddings blur.
- Re-embed and reindex when the embedding model or chunking changes; never mix embedding spaces.
- Instruct the model to refuse when context is missing rather than filling gaps from parametric memory.
