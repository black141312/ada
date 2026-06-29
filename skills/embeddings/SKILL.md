---
name: embeddings
description: Set up embeddings and a vector store for semantic search or retrieval
category: data-ml
---

# Embeddings

Use when you need semantic search, clustering, dedup, or retrieval and must turn text (or other data) into vectors stored in an index.

1. Pick an embedding model matched to the domain and language; note its dimensionality, max input length, and cost.
2. Preprocess and chunk inputs to fit the model's token limit, keeping a stable id and metadata for each item.
3. Batch the embedding calls, handle rate limits/retries, and normalize vectors if your similarity metric expects it (cosine).
4. Store vectors in a vector store (FAISS, pgvector, or a managed index) with the chosen distance metric and an ANN index sized to your recall/latency target.
5. Query by embedding the query the same way, retrieving top-k, and verifying results make semantic sense on real queries.
6. Persist the model name and version with the index so you can detect and handle re-embedding needs.

## Rules
- Embed queries and documents with the exact same model and preprocessing — mismatches silently wreck recall.
- Match the index's distance metric to the model (most use cosine/dot on normalized vectors); don't mix metrics.
- Re-embedding is required when you change the model, dimension, or chunking — version the index accordingly.
- Store source ids and metadata alongside vectors so retrieved hits can be traced back and filtered.
- Benchmark recall and latency at your real data size; small-sample behavior doesn't predict ANN tradeoffs.
