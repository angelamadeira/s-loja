-- Vídeo "reel" do produto — o que toca no botão flutuante da vitrine (p.video no
-- index.html), separado da galeria (que é a mídia da página do produto).
ALTER TABLE cat_produtos ADD COLUMN video_asset TEXT REFERENCES assets(id);
