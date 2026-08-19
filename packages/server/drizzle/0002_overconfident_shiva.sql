CREATE TABLE "abdruecke" (
	"schluessel" text PRIMARY KEY NOT NULL,
	"marke" text NOT NULL,
	"abdruck" jsonb NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL
);
