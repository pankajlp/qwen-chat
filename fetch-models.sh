#!/bin/sh
# Download the browser Whisper weights (only needed for the in-browser voice fallback).
# Source: Hugging Face, Xenova/whisper-{base,small,medium}, quantized ONNX.
#   ./fetch-models.sh              all three (~1.2 GB)
#   ./fetch-models.sh base small   only some
cd "$(dirname "$0")" || exit 1
set -e
for m in ${@:-base small medium}; do
  mkdir -p "vendor/models/whisper-$m/onnx"
  for f in encoder_model_quantized.onnx decoder_model_merged_quantized.onnx; do
    out="vendor/models/whisper-$m/onnx/$f"
    [ -s "$out" ] && { echo "have $out"; continue; }
    echo "fetching $out"
    curl -fL --retry 3 -o "$out.part" "https://huggingface.co/Xenova/whisper-$m/resolve/main/onnx/$f"
    mv "$out.part" "$out"
  done
done
