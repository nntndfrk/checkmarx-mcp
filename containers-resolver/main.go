// Command containers-resolver runs the container resolution step of
// `cx scan create` (ast-cli runContainerResolver) for checkmarx-mcp.
//
// It calls the same containers-resolver steps as ContainersResolver.Resolve,
// but not its cleanup: for a directory input, cleanup deletes the scanned
// directory whenever the resolution folder is a different folder. The scan
// path is only read, and the output goes to a separate folder:
//
//   - containers-resolution.json: the file `cx` adds to the zip, byte for byte.
//   - images.json: the images the resolver tried to analyse and the module
//     versions it was built with, for the MCP tool result.
//
// Build it inside the ast-cli module at the tag to match, so that its go.mod
// and go.sum select the same containers-resolver, syft and stereoscope
// versions as that `cx` release:
//
//	git clone --depth 1 --branch 2.3.27 https://github.com/Checkmarx/ast-cli /src
//	mkdir -p /src/cmd/cxmcp-containers-resolver
//	cp main.go /src/cmd/cxmcp-containers-resolver/
//	cd /src && CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath \
//	  -o containers-resolver ./cmd/cxmcp-containers-resolver
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"

	containersResolver "github.com/Checkmarx/containers-resolver/pkg/containerResolver"
	"github.com/Checkmarx/containers-types/types"
	"github.com/rs/zerolog"
)

// Modules reported in images.json.
var reportedModules = map[string]string{
	"github.com/Checkmarx/containers-resolver":                "containers-resolver",
	"github.com/Checkmarx/containers-images-extractor":        "containers-images-extractor",
	"github.com/Checkmarx/containers-syft-packages-extractor": "containers-syft-packages-extractor",
	"github.com/anchore/syft":                                 "syft",
	"github.com/anchore/stereoscope":                          "stereoscope",
}

type info struct {
	Modules map[string]string  `json:"modules"`
	Images  []types.ImageModel `json:"images"`
}

func main() {
	scanPath := flag.String("scan-path", "", "folder to resolve; it is only read")
	outputPath := flag.String("output-path", "", "existing folder for the output files")
	images := flag.String("images", "", "comma-separated images, the same value as cx --container-images")
	flag.Parse()
	if *scanPath == "" || *outputPath == "" {
		flag.Usage()
		os.Exit(2)
	}

	// cx passes its --debug flag; debug output makes failures easier to read.
	zerolog.SetGlobalLevel(zerolog.DebugLevel)

	var userImages []string
	if *images != "" {
		userImages = strings.Split(*images, ",")
	}

	resolver := containersResolver.NewContainerResolver()
	files, settingsFiles, _, err := resolver.ExtractFiles(*scanPath)
	if err != nil {
		fail("could not extract files", err)
	}
	toAnalyze, err := resolver.ExtractAndMergeImagesFromFiles(
		files, types.ToImageModels(userImages), settingsFiles)
	if err != nil {
		fail("could not extract images from files", err)
	}
	if err := writeJSON(filepath.Join(*outputPath, "images.json"),
		info{Modules: moduleVersions(), Images: toAnalyze}); err != nil {
		fail("could not write images.json", err)
	}
	resolution, err := resolver.AnalyzeImages(toAnalyze)
	if err != nil {
		fail("could not analyze images", err)
	}
	if err := resolver.SaveObjectToFile(*outputPath, resolution); err != nil {
		fail("could not save the resolution", err)
	}
}

func moduleVersions() map[string]string {
	versions := map[string]string{}
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return versions
	}
	for _, dep := range build.Deps {
		if name, ok := reportedModules[dep.Path]; ok {
			versions[name] = dep.Version
		}
	}
	return versions
}

func writeJSON(path string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func fail(message string, err error) {
	fmt.Fprintf(os.Stderr, "containers-resolver: %s: %v\n", message, err)
	os.Exit(1)
}
