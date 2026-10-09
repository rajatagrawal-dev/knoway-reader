// The images a message carries: a dive's region screenshot (`image`, one)
// and whatever regions the reader added to the question (`images`, any).
export function messageImages(message) {
  return [...(message.image ? [message.image] : []), ...(Array.isArray(message.images) ? message.images : [])].filter(
    (image) => image && typeof image.mediaType === "string" && typeof image.data === "string",
  );
}
